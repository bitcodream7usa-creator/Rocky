import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fileToBase64 } from "@hatch/space-sdk/client";
import { PdfViewer } from "@hatch/space-sdk/pdf";
import { api, type ApiResponse } from "./api";
import {
GENESIS_HASH,
RECOVERY_WORD_COUNT,
base64ToBytes,
buildBackupPackage,
buildRecoveryEnvelope,
bytesToBase64,
generateRecoveryPhrase,
openBackupPackage,
openRecoveryEnvelope,
parseRecoveryPhrase,
type PlainBackupItem,
} from "./backup";

type VaultItem = NonNullable<
  ApiResponse<typeof api, "listItems">["items"]
>[number];

type BackupEntry = NonNullable<
  ApiResponse<typeof api, "listBackups">["backups"]
>[number];

type Phase =
  | "boot"
  | "setup"
  | "recoverySetup"
  | "locked"
  | "createVault"
  | "unlocked";

// The vault the current pattern opens. Which vault you are in is
// decided entirely by the pattern you drew — there is no vault picker
// on the locked screen, so a locked client learns nothing about the
// other vaults, not even their names.
interface CurrentVault {
  id: number;
  name: string;
  gridSize: number;
}

/* ---------------------------------- utils --------------------------------- */

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("ko-KR", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function kindOf(item: { mimeType: string; name: string }): string {
  const m = item.mimeType;
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf" || item.name.toLowerCase().endsWith(".pdf"))
    return "pdf";
  if (m.startsWith("text/")) return "text";
  return "file";
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

// Turn a thrown action/transport failure into a short human-readable
// detail the UI can show next to the step that failed, so a failure
// names its cause (HTTP status, network error, crypto error) instead
// of collapsing into a generic "try again".
function describeError(e: unknown): string {
  if (e instanceof Error) {
    const status = (e as { status?: unknown }).status;
    const code = (e as { code?: unknown }).code;
    const parts = [e.message];
    if (typeof status === "number") parts.push(`HTTP ${status}`);
    if (typeof code === "string" && code) parts.push(code);
    return parts.join(" · ");
  }
  return String(e);
}

/* --------------------------- mobile file saving --------------------------- */

// How a file leaves the vault on a phone. The old export was an
// <a download> pointing at the server's blob URL, and on mobile that
// routinely does nothing: iOS Safari and in-app webviews ignore the
// download attribute for cross-origin URLs, and the blob responses
// carry sandbox headers that stop them being saved as files. So every
// export now pulls the bytes through the action channel (the channel
// uploads already prove works) and saves a LOCAL blob instead:
//   1. Web Share with a File — the native share sheet is the one save
//      path every phone offers (파일에 저장, 사진 앱, 드라이브…).
//   2. A local object-URL anchor click — desktop browsers and Android
//      Chrome save this as a real download.
//   3. Return "manual" so the caller can keep the bytes and show an
//      explicit 저장 button the user taps as a fresh gesture.
type SaveOutcome = "shared" | "downloaded" | "manual";

function isSaveCancelled(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

async function saveFileToDevice(opts: {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}): Promise<SaveOutcome> {
  const blob = new Blob([opts.bytes.buffer as ArrayBuffer], {
    type: opts.mimeType || "application/octet-stream",
  });
  const nav = navigator as Navigator & {
    canShare?: (data: { files: File[] }) => boolean;
    share?: (data: { files: File[]; title?: string }) => Promise<void>;
  };
  if (typeof nav.share === "function" && typeof nav.canShare === "function") {
    try {
      const file = new File([blob], opts.name, { type: blob.type });
      if (nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: opts.name });
        return "shared";
      }
    } catch (e) {
      // The user closing the share sheet is a fine outcome, not an
      // error — and Safari throws if we fall through to a synthetic
      // click right after a share, so stop here.
      if (isSaveCancelled(e)) return "shared";
      // A genuine share failure falls through to the download path.
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = opts.name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return "downloaded";
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

/* ---------------------------------- icons --------------------------------- */

function IconLock({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function IconPlus({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function IconBack({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function IconDownload({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 3v12" />
      <path d="M6 11l6 6 6-6" />
      <path d="M4 21h16" />
    </svg>
  );
}

function IconUpload({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 15V3" />
      <path d="M6 7l6-6 6 6" />
      <path d="M4 21h16" />
    </svg>
  );
}

function IconChain({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
      <path d="M10 6.5h6a2 2 0 0 1 2 2V14" />
      <path d="M14 17.5H8a2 2 0 0 1-2-2V10" />
    </svg>
  );
}

function IconKey({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="8" cy="14" r="4.5" />
      <path d="M11.2 10.8L20 2" />
      <path d="M16 6l3 3" />
      <path d="M13.5 8.5l2.5 2.5" />
    </svg>
  );
}

function IconCode({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M8 6l-6 6 6 6" />
      <path d="M16 6l6 6-6 6" />
    </svg>
  );
}

function IconShare({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 15V3" />
      <path d="M7 8l5-5 5 5" />
      <path d="M5 13v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7" />
    </svg>
  );
}

function IconPhone({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <path d="M11 18h2" />
    </svg>
  );
}

function IconTrash({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

function IconFile({ kind, className }: { kind: string; className?: string }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
  };
  if (kind === "image")
    return (
      <svg {...common}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="9" cy="10" r="1.6" />
        <path d="M21 16l-5-5-9 9" />
      </svg>
    );
  if (kind === "video")
    return (
      <svg {...common}>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M10 9.5l5 2.5-5 2.5z" />
      </svg>
    );
  if (kind === "audio")
    return (
      <svg {...common}>
        <path d="M9 18V6l10-2v11" />
        <circle cx="6.5" cy="18" r="2.5" />
        <circle cx="16.5" cy="15" r="2.5" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="M6 2h8l4 4v16H6z" />
      <path d="M14 2v4h4" />
      <path d="M9 12h6M9 16h6" />
    </svg>
  );
}

/* ------------------------------- pattern pad ------------------------------ */

const PAD = 300;

function dotCenters(grid: number): ReadonlyArray<{ x: number; y: number }> {
  const cell = PAD / grid;
  return Array.from({ length: grid * grid }, (_, i) => ({
    x: ((i % grid) + 0.5) * cell,
    y: (Math.floor(i / grid) + 0.5) * cell,
  }));
}

function PatternPad({
  grid,
  onComplete,
  error,
  disabled,
  resetKey,
  label,
}: {
  grid: number;
  onComplete: (pattern: number[]) => void;
  error: boolean;
  disabled: boolean;
  resetKey: number;
  label: string;
}) {
  const [path, setPath] = useState<number[]>([]);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(
    null,
  );
  const drawingRef = useRef(false);
  const pathRef = useRef<number[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);
  const centersRef = useRef(dotCenters(grid));
  centersRef.current = dotCenters(grid);

  useEffect(() => {
    pathRef.current = [];
    setPath([]);
    setPointer(null);
    drawingRef.current = false;
  }, [resetKey, grid]);

  const toPadCoords = useCallback((e: ReactPointerEvent) => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const scale = PAD / rect.width;
    return {
      x: (e.clientX - rect.left) * scale,
      y: (e.clientY - rect.top) * scale,
    };
  }, []);

  const hitDot = useCallback(
    (x: number, y: number): number => {
      const centers = centersRef.current;
      let best = -1;
      let bestDist = Infinity;
      centers.forEach((c, i) => {
        const d = Math.hypot(c.x - x, c.y - y);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      });
      return bestDist <= PAD / grid / 2 ? best : -1;
    },
    [grid],
  );

  const extendPath = useCallback(
    (dot: number) => {
      const current = pathRef.current;
      if (current.includes(dot)) return;
      const last = current[current.length - 1];
      let next = [...current];
      if (last !== undefined) {
        // Dots lying exactly on the segment to the new dot are selected
        // first, the way phone pattern locks behave. On a grid, those
        // are the lattice points spaced by the gcd of the delta.
        const lx = last % grid;
        const ly = Math.floor(last / grid);
        const sx = (dot % grid) - lx;
        const sy = Math.floor(dot / grid) - ly;
        const steps = gcd(Math.abs(sx), Math.abs(sy));
        if (steps > 1) {
          for (let k = 1; k < steps; k++) {
            const mid =
              (ly + (sy / steps) * k) * grid + (lx + (sx / steps) * k);
            if (!next.includes(mid)) next = [...next, mid];
          }
        }
      }
      next = [...next, dot];
      pathRef.current = next;
      setPath(next);
    },
    [grid],
  );

  const handleDown = (e: ReactPointerEvent) => {
    if (disabled) return;
    const p = toPadCoords(e);
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    pathRef.current = [];
    setPath([]);
    const dot = hitDot(p.x, p.y);
    if (dot >= 0) extendPath(dot);
    setPointer(p);
  };

  const handleMove = (e: ReactPointerEvent) => {
    if (!drawingRef.current || disabled) return;
    const p = toPadCoords(e);
    if (!p) return;
    setPointer(p);
    const dot = hitDot(p.x, p.y);
    if (dot >= 0) extendPath(dot);
  };

  const handleUp = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    setPointer(null);
    const finished = [...pathRef.current];
    if (finished.length > 0) onComplete(finished);
  };

  const centers = centersRef.current;
  const linePoints = path
    .map((i) => {
      const c = centers[i];
      return c ? `${c.x},${c.y}` : "";
    })
    .filter(Boolean)
    .join(" ");
  const lastCenter = path.length > 0 ? centers[path[path.length - 1]!] : null;
  const dotR = grid >= 5 ? 7 : 9;
  const dotRActive = grid >= 5 ? 10.5 : 13;

  return (
    <div
      ref={boxRef}
      role="application"
      aria-label={label}
      className={`relative aspect-square w-full max-w-[340px] touch-none select-none ${
        error ? "shake" : ""
      } ${disabled ? "pointer-events-none opacity-60" : ""}`}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
    >
      <svg viewBox={`0 0 ${PAD} ${PAD}`} className="h-full w-full">
        {linePoints && (
          <polyline
            points={linePoints}
            fill="none"
            stroke={error ? "var(--danger)" : "var(--accent)"}
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.85"
          />
        )}
        {pointer && lastCenter && (
          <line
            x1={lastCenter.x}
            y1={lastCenter.y}
            x2={pointer.x}
            y2={pointer.y}
            stroke={error ? "var(--danger)" : "var(--accent)"}
            strokeWidth="5"
            strokeLinecap="round"
            opacity="0.5"
          />
        )}
        {centers.map((c, i) => {
          const active = path.includes(i);
          return (
            <g key={i}>
              <circle cx={c.x} cy={c.y} r={PAD / grid / 2} fill="transparent" />
              <circle
                cx={c.x}
                cy={c.y}
                r={active ? dotRActive : dotR}
                fill={
                  active
                    ? error
                      ? "var(--danger)"
                      : "var(--accent)"
                    : "var(--surface-2)"
                }
                stroke={error ? "var(--danger)" : "var(--accent)"}
                strokeWidth="2"
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ------------------------------ lock screens ------------------------------ */

function LockScreen({
  title,
  message,
  error,
  busy,
  resetKey,
  grid,
  onComplete,
  footnote,
  recovery,
  onShowInstall,
  extra,
  belowPad,
}: {
  title: string;
  message: string;
  error: boolean;
  busy: boolean;
  resetKey: number;
  grid: number;
  onComplete: (pattern: number[]) => void;
  footnote?: string;
  recovery?: { hasRecovery: boolean; onOpen: () => void };
  onShowInstall?: () => void;
  extra?: ReactNode;
  belowPad?: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 pt-safe pb-safe">
      <div className="flex w-full max-w-sm flex-col items-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)]">
          <IconLock className="h-6 w-6 text-[var(--accent)]" />
        </div>
        <h1 className="mt-6 text-center text-2xl font-semibold text-[var(--text)]">
          {title}
        </h1>
        <p
          className={`mt-2 min-h-6 text-center text-sm ${
            error ? "text-[var(--danger)]" : "text-[var(--dim)]"
          }`}
          role={error ? "alert" : undefined}
        >
          {message}
        </p>
        {extra}
        <div className="mt-4 flex w-full justify-center">
          <PatternPad
            grid={grid}
            onComplete={onComplete}
            error={error}
            disabled={busy}
            resetKey={resetKey}
            label={title}
          />
        </div>
        {belowPad}
        {recovery &&
          (recovery.hasRecovery ? (
            <button
              type="button"
              onClick={recovery.onOpen}
              className="mt-8 flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm text-[var(--text)]"
            >
              <IconKey className="h-4 w-4 text-[var(--accent)]" />
              패턴을 잊었어요 — 회복 문구로 열기
            </button>
          ) : (
            <p className="mt-8 max-w-xs text-center text-xs leading-5 text-[var(--dim)]">
              회복 문구가 아직 없어서, 패턴을 잊으면 이 금고를 열 방법이
              없어요. 금고를 연 뒤 ‘회복’ 탭에서 문구를 만들어 두세요.
            </p>
          ))}
        {footnote && (
          <p className="mt-8 max-w-xs text-center text-xs leading-5 text-[var(--dim)]">
            {footnote}
          </p>
        )}
        {onShowInstall && (
          <button
            type="button"
            onClick={onShowInstall}
            className="mt-4 flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm text-[var(--text)]"
          >
            <IconPhone className="h-4 w-4 text-[var(--accent)]" />
            모바일 설치·저장 안내
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------- item thumb ------------------------------- */

function ItemThumb({ pattern, item }: { pattern: number[]; item: VaultItem }) {
  const kind = kindOf(item);
  const urlQuery = useQuery({
    queryKey: ["item-url", item.id],
    queryFn: async () => {
      const res = await api.getItemUrl({ pattern, id: item.id });
      if (!res.ok || !res.url) throw new Error("unavailable");
      return res.url;
    },
    enabled: kind === "image",
    staleTime: 5 * 60 * 1000,
  });
  if (kind === "image" && urlQuery.data) {
    return (
      <img
        src={urlQuery.data}
        alt={item.name}
        className="h-full w-full object-cover"
        loading="lazy"
      />
    );
  }
  return (
    <div className="flex h-full w-full items-center justify-center">
      <IconFile kind={kind} className="h-10 w-10 text-[var(--dim)]" />
    </div>
  );
}

/* ------------------------------- item viewer ------------------------------ */

function ItemViewer({
  pattern,
  item,
  onBack,
  onDeleted,
}: {
  pattern: number[];
  item: VaultItem;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const kind = kindOf(item);

  const urlQuery = useQuery({
    queryKey: ["item-url", item.id],
    queryFn: async () => {
      const res = await api.getItemUrl({ pattern, id: item.id });
      if (!res.ok || !res.url) throw new Error("unavailable");
      return res.url;
    },
    staleTime: 5 * 60 * 1000,
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteItem({ pattern, id: item.id }),
    onSuccess: (res) => {
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ["vault-items"] });
        onDeleted();
      }
    },
  });

  const url = urlQuery.data;

  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  // 꺼내기 on mobile: fetch the bytes through the action channel and
  // hand a local file to the share sheet / download, instead of linking
  // at the server blob URL (which phones won't save — see
  // saveFileToDevice). This click is a fresh user gesture, which is
  // exactly what the share sheet requires.
  const exportItem = useCallback(async () => {
    setExportNotice(null);
    setExporting(true);
    try {
      let bytes: Uint8Array | null = null;
      const data = await api.getItemData({ pattern, id: item.id });
      if (data.ok && data.dataBase64) {
        bytes = base64ToBytes(data.dataBase64);
      } else if (url) {
        const resp = await fetch(url);
        if (resp.ok) bytes = new Uint8Array(await resp.arrayBuffer());
      }
      if (!bytes) {
        setExportNotice("파일 내용을 읽지 못해서 꺼내지 못했어요.");
        return;
      }
      const outcome = await saveFileToDevice({
        name: item.name,
        mimeType: item.mimeType,
        bytes,
      });
      setExportNotice(
        outcome === "shared"
          ? "공유 시트에서 ‘파일에 저장’이나 보낼 앱을 선택하면 금고 밖에 저장돼요."
          : "내려받기가 시작됐어요. 휴대폰의 다운로드 폴더나 파일 앱에서 확인하세요.",
      );
    } catch (e) {
      setExportNotice(`꺼내지 못했어요: ${describeError(e)}`);
    } finally {
      setExporting(false);
    }
  }, [item, pattern, url]);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 pb-10">
      <div className="flex flex-wrap items-center gap-2 py-4">
        <button
          type="button"
          onClick={onBack}
          aria-label="목록으로 돌아가기"
          className="flex min-h-11 items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
        >
          <IconBack className="h-4 w-4" />
          목록
        </button>
        <div className="min-w-0 flex-1 basis-40">
          <p className="truncate text-base font-medium text-[var(--text)]">
            {item.name}
          </p>
          <p className="font-mono text-xs text-[var(--dim)]">
            {formatSize(item.size)} · {formatDate(item.createdAt)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void exportItem()}
          disabled={exporting}
          aria-label="금고 밖으로 꺼내기"
          className="flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-[#161305] disabled:opacity-50"
        >
          <IconShare className="h-4 w-4" />
          {exporting ? "준비 중…" : "꺼내기"}
        </button>
        <button
          type="button"
          onClick={() => setConfirmDelete(true)}
          aria-label="금고에서 삭제하기"
          className="flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--danger)] px-3 py-2 text-sm text-[var(--danger)]"
        >
          <IconTrash className="h-4 w-4" />
          삭제
        </button>
      </div>

      {exportNotice && (
        <p
          role="status"
          className="mb-4 rounded-lg border border-[var(--accent)] bg-[var(--surface)] px-4 py-3 text-sm leading-6 text-[var(--text)]"
        >
          {exportNotice}
        </p>
      )}

      {confirmDelete && (
        <div
          role="alertdialog"
          aria-label="삭제 확인"
          className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--danger)] bg-[var(--surface)] px-4 py-3"
        >
          <p className="flex-1 text-sm text-[var(--text)]">
            이 파일을 금고에서 완전히 삭제할까요? 되돌릴 수 없어요.
          </p>
          <button
            type="button"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
            className="min-h-11 rounded-lg bg-[var(--danger)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {deleteMutation.isPending ? "삭제 중…" : "삭제하기"}
          </button>
          <button
            type="button"
            onClick={() => setConfirmDelete(false)}
            className="min-h-11 rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text)]"
          >
            취소
          </button>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        {urlQuery.isPending && (
          <p className="px-4 py-16 text-center text-sm text-[var(--dim)]">
            불러오는 중…
          </p>
        )}
        {urlQuery.isError && (
          <p className="px-4 py-16 text-center text-sm text-[var(--danger)]">
            파일을 열 수 없어요. 잠시 뒤 다시 시도해 주세요.
          </p>
        )}
        {url && kind === "image" && (
          <img
            src={url}
            alt={item.name}
            className="max-h-[70vh] w-full object-contain"
          />
        )}
        {url && kind === "video" && (
          <video src={url} controls className="max-h-[70vh] w-full" />
        )}
        {url && kind === "audio" && (
          <div className="px-6 py-10">
            <audio src={url} controls className="w-full" aria-label={item.name} />
          </div>
        )}
        {url && kind === "pdf" && (
          <PdfViewer
            src={url}
            ariaLabel={item.name}
            labels={{
              loading: "불러오는 중…",
              loadError: "PDF를 열 수 없어요.",
              pageError: "페이지를 표시할 수 없어요.",
              previousPage: "이전 페이지",
              nextPage: "다음 페이지",
              pageIndicator: (p, t) => `${p} / ${t}`,
              navigationAriaLabel: "PDF 페이지 이동",
              pageAriaLabel: (p) => `${p}페이지`,
            }}
          />
        )}
        {url && kind !== "image" && kind !== "video" && kind !== "audio" && kind !== "pdf" && (
          <div className="flex flex-col items-center px-6 py-14 text-center">
            <IconFile kind={kind} className="h-14 w-14 text-[var(--dim)]" />
            <p className="mt-4 text-sm text-[var(--dim)]">
              이 형식은 금고 안에서 미리 볼 수 없어요. 꺼내서 확인해 주세요.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- recovery phrase ---------------------------- */

// Shared phrase entry: one text field the user types or pastes the 9
// words into, with a live word count so they can see where they stand.
function RecoveryPhraseEntry({
  value,
  onChange,
  disabled,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  label: string;
}) {
  const words = parseRecoveryPhrase(value);
  return (
    <div>
      <label
        htmlFor="recovery-phrase-input"
        className="text-sm font-medium text-[var(--text)]"
      >
        {label}
      </label>
      <textarea
        id="recovery-phrase-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        rows={3}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        placeholder="예: river apple stone …"
        className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 font-mono text-base text-[var(--text)] disabled:opacity-50"
      />
      <p className="mt-1.5 font-mono text-xs text-[var(--dim)]">
        {words.length} / {RECOVERY_WORD_COUNT} 단어
        {words.length > 0 &&
          words.length <= RECOVERY_WORD_COUNT &&
          " · 띄어쓰기로 구분해 순서대로 입력하세요"}
      </p>
    </div>
  );
}

// Generate-and-save flow, shared by first-run setup and the recovery
// panel: show a fresh 9-word phrase once, require the user to confirm
// they wrote it down, then seal the pattern under it and store only
// the envelope.
function RecoverySetupFlow({
  pattern,
  onSaved,
  onCancel,
  cancelLabel,
}: {
  pattern: number[];
  onSaved: () => void;
  onCancel: () => void;
  cancelLabel: string;
}) {
  const queryClient = useQueryClient();
  const [phrase, setPhrase] = useState<string[]>(() =>
    generateRecoveryPhrase(),
  );
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const regenerate = useCallback(() => {
    setPhrase(generateRecoveryPhrase());
    setConfirmed(false);
    setErrorText(null);
  }, []);

  const save = useCallback(async () => {
    setErrorText(null);
    setBusy(true);
    try {
      const createdAt = new Date().toISOString();
      const envelopeJson = await buildRecoveryEnvelope({
        pattern,
        phrase,
        createdAt,
      });
      const res = await api.setRecoveryEnvelope({
        pattern,
        envelopeJson,
        createdAt,
      });
      if (!res.ok) {
        setErrorText(
          res.error === "locked"
            ? "패턴을 확인하지 못했어요. 금고를 잠갔다가 다시 열어 주세요."
            : "회복 문구를 저장하지 못했어요. 다시 시도해 주세요.",
        );
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["vault-status"] });
      await queryClient.invalidateQueries({
        queryKey: ["recovery-own"],
      });
      onSaved();
    } catch (e) {
      setErrorText(`저장하지 못했어요: ${describeError(e)}`);
    } finally {
      setBusy(false);
    }
  }, [onSaved, pattern, phrase, queryClient]);

  return (
    <div>
      <p className="text-sm leading-6 text-[var(--dim)]">
        아래 9단어가 회복 문구예요. 패턴을 잊었을 때 이 문구를 입력하면
        패턴을 되찾아 금고와 백업을 열 수 있어요. 문구 자체는 이 기기
        밖으로 나가지 않고, 서버에는 문구로 잠긴 패턴 봉투만 저장돼요.
      </p>
      <ol
        aria-label="회복 문구 9단어"
        className="mt-4 grid grid-cols-3 gap-2"
      >
        {phrase.map((word, i) => (
          <li
            key={`${i}-${word}`}
            className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5"
          >
            <span className="font-mono text-xs text-[var(--dim)]">
              {i + 1}
            </span>
            <span className="mt-0.5 block font-mono text-base font-semibold text-[var(--text)]">
              {word}
            </span>
          </li>
        ))}
      </ol>
      <p
        role="alert"
        className="mt-4 rounded-lg border border-[var(--danger)] px-4 py-3 text-sm leading-6 text-[var(--danger)]"
      >
        이 문구는 지금 한 번만 보여요. 종이에 적어 안전한 곳에 보관하세요.
        문구를 가진 사람은 누구나 금고를 열 수 있고, 문구까지 잃으면
        패턴을 잊었을 때 되찾을 방법이 없어요.
      </p>
      <label className="mt-4 flex min-h-11 cursor-pointer items-start gap-2.5 text-sm leading-6 text-[var(--text)]">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-1 h-5 w-5 shrink-0 accent-[var(--accent)]"
        />
        9단어를 순서대로 적어 안전하게 보관했어요.
      </label>
      {errorText && (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-[var(--danger)] px-4 py-3 text-sm text-[var(--danger)]"
        >
          {errorText}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!confirmed || busy}
          className="min-h-11 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#161305] disabled:opacity-50"
        >
          {busy ? "봉투를 만들고 있어요…" : "회복 문구 저장하기"}
        </button>
        <button
          type="button"
          onClick={regenerate}
          disabled={busy}
          className="min-h-11 rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--text)] disabled:opacity-50"
        >
          다른 문구로 다시 뽑기
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="min-h-11 rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--dim)] disabled:opacity-50"
        >
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}

// Locked-screen recovery: type the phrase, open the envelope on this
// device, then let the server re-verify the recovered pattern exactly
// like a drawn one before anything is shown.
function RecoveryUnlockView({
  onBack,
  onRecovered,
}: {
  onBack: () => void;
  onRecovered: (pattern: number[], vault: CurrentVault) => void;
}) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const words = parseRecoveryPhrase(input);

  const submit = useCallback(async () => {
    setErrorText(null);
    if (words.length !== RECOVERY_WORD_COUNT) {
      setErrorText(
        `회복 문구는 ${RECOVERY_WORD_COUNT}단어예요. 지금 ${words.length}단어가 입력됐어요.`,
      );
      return;
    }
    setBusy(true);
    try {
      const env = await api.getRecoveryEnvelope({});
      if (!env.hasRecovery || env.envelopes.length === 0) {
        setErrorText(
          "저장된 회복 문구가 없어요. 패턴으로만 열 수 있는 금고예요.",
        );
        return;
      }
      // Every vault's envelope is ciphertext; try the phrase against
      // each one. The envelope whose auth tag verifies names the
      // pattern — and with several vaults, also which vault it opens.
      let recovered: number[] | null = null;
      for (const entry of env.envelopes) {
        const opened = await openRecoveryEnvelope(entry.envelopeJson, words);
        if (opened.ok) {
          recovered = opened.pattern;
          break;
        }
      }
      if (!recovered) {
        setErrorText(
          "이 문구로는 열 수 없어요. 단어와 순서를 확인해 주세요. 어떤 단어가 틀렸는지는 알려드릴 수 없어요.",
        );
        return;
      }
      const check = await api.unlock({ pattern: recovered });
      if (!check.ok || check.vaultId == null) {
        setErrorText(
          "문구로 되찾은 패턴이 지금 금고와 맞지 않아요. 패턴이 바뀐 뒤 만든 문구가 필요해요.",
        );
        return;
      }
      onRecovered(recovered, {
        id: check.vaultId,
        name: check.vaultName ?? "내 금고",
        gridSize: check.gridSize ?? 5,
      });
    } catch (e) {
      setErrorText(`열지 못했어요: ${describeError(e)}`);
    } finally {
      setBusy(false);
    }
  }, [onRecovered, words]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 pt-safe pb-safe">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)]">
            <IconKey className="h-6 w-6 text-[var(--accent)]" />
          </div>
          <h1 className="mt-6 text-center text-2xl font-semibold text-[var(--text)]">
            회복 문구로 열기
          </h1>
          <p className="mt-2 text-center text-sm leading-6 text-[var(--dim)]">
            보관해 둔 9단어를 순서대로 입력하세요. 문구가 맞으면 패턴을
            되찾아 금고가 열리고, 백업도 그 패턴으로 복원할 수 있어요.
          </p>
        </div>
        <div className="mt-6">
          <RecoveryPhraseEntry
            value={input}
            onChange={setInput}
            disabled={busy}
            label="회복 문구 9단어"
          />
        </div>
        {errorText && (
          <p
            role="alert"
            className="mt-3 rounded-lg border border-[var(--danger)] px-4 py-3 text-sm leading-6 text-[var(--danger)]"
          >
            {errorText}
          </p>
        )}
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || words.length !== RECOVERY_WORD_COUNT}
          className="mt-4 min-h-11 w-full rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#161305] disabled:opacity-50"
        >
          {busy ? "문구를 확인하고 있어요…" : "회복 문구로 금고 열기"}
        </button>
        <button
          type="button"
          onClick={onBack}
          disabled={busy}
          className="mt-2 flex min-h-11 w-full items-center justify-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm text-[var(--text)] disabled:opacity-50"
        >
          <IconBack className="h-4 w-4" />
          패턴으로 열기
        </button>
      </div>
    </div>
  );
}

// Recovery management inside the unlocked vault: status, create or
// replace the phrase, test a phrase against the stored envelope, and
// delete it.
function RecoveryPanel({ pattern }: { pattern: number[] }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"view" | "setup" | "test">("view");
  const [notice, setNotice] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [testInput, setTestInput] = useState("");
  const [testBusy, setTestBusy] = useState(false);

  const envelopeQuery = useQuery({
    queryKey: ["recovery-own"],
    queryFn: async () => {
      const res = await api.getOwnRecovery({ pattern });
      if (!res.ok) throw new Error("locked");
      return res;
    },
  });
  const hasRecovery = envelopeQuery.data?.hasRecovery ?? false;
  const createdAt = envelopeQuery.data?.createdAt;

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteRecoveryEnvelope({ pattern }),
    onSuccess: async (res) => {
      setConfirmDelete(false);
      if (res.ok) {
        await queryClient.invalidateQueries({ queryKey: ["vault-status"] });
        await queryClient.invalidateQueries({
          queryKey: ["recovery-own"],
        });
        setNotice({
          kind: "ok",
          text: "회복 문구를 삭제했어요. 이제 패턴을 잊으면 금고를 열 수 없어요.",
        });
      } else {
        setNotice({
          kind: "err",
          text: "삭제하지 못했어요. 패턴을 확인하지 못했어요.",
        });
      }
    },
    onError: (e) =>
      setNotice({ kind: "err", text: `삭제하지 못했어요: ${describeError(e)}` }),
  });

  const runTest = useCallback(async () => {
    const words = parseRecoveryPhrase(testInput);
    if (words.length !== RECOVERY_WORD_COUNT) {
      setNotice({
        kind: "err",
        text: `회복 문구는 ${RECOVERY_WORD_COUNT}단어예요. 지금 ${words.length}단어가 입력됐어요.`,
      });
      return;
    }
    const envelopeJson = envelopeQuery.data?.envelopeJson;
    if (!envelopeJson) {
      setNotice({ kind: "err", text: "저장된 회복 문구가 없어요." });
      return;
    }
    setTestBusy(true);
    try {
      const opened = await openRecoveryEnvelope(envelopeJson, words);
      setNotice(
        opened.ok
          ? {
              kind: "ok",
              text: "확인됐어요. 이 문구로 패턴을 되찾아 금고를 열 수 있어요.",
            }
          : {
              kind: "err",
              text: "이 문구로는 열 수 없어요. 적어 둔 단어와 순서를 확인해 주세요.",
            },
      );
      if (opened.ok) setTestInput("");
    } catch (e) {
      setNotice({ kind: "err", text: `확인하지 못했어요: ${describeError(e)}` });
    } finally {
      setTestBusy(false);
    }
  }, [envelopeQuery.data, testInput]);

  return (
    <div>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-5">
        <div className="flex items-start gap-3">
          <IconKey className="mt-0.5 h-6 w-6 shrink-0 text-[var(--accent)]" />
          <div>
            <h2 className="text-base font-semibold text-[var(--text)]">
              회복 문구
            </h2>
            <p className="mt-1.5 text-sm leading-6 text-[var(--dim)]">
              패턴을 잊었을 때를 대비한 두 번째 열쇠예요. 9단어 문구에서
              만든 키가 패턴을 감싼 봉투를 열고, 되찾은 패턴으로 금고와
              백업을 모두 열 수 있어요. 문구 자체는 서버에 저장되지
              않아요. 패턴을 바꾸면 예전 문구는 무효가 되니, 바꾼 뒤에는
              새 문구를 만들어 주세요.
            </p>
          </div>
        </div>

        {envelopeQuery.isPending && (
          <p className="mt-4 font-mono text-xs text-[var(--dim)]">
            확인하고 있어요…
          </p>
        )}
        {envelopeQuery.isError && (
          <div className="mt-4">
            <p role="alert" className="text-sm text-[var(--danger)]">
              회복 문구 상태를 확인하지 못했어요.
            </p>
            <button
              type="button"
              onClick={() => void envelopeQuery.refetch()}
              className="mt-3 min-h-11 rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--text)]"
            >
              다시 시도
            </button>
          </div>
        )}

        {envelopeQuery.isSuccess && mode === "setup" && (
          <div className="mt-5 border-t border-[var(--border)] pt-5">
            {hasRecovery && (
              <p className="mb-4 rounded-lg border border-[var(--danger)] px-4 py-3 text-sm leading-6 text-[var(--danger)]">
                새 문구를 저장하면 예전 문구는 바로 무효가 돼요. 예전
                문구를 적어 둔 종이는 버리고 새 문구로 바꿔 보관하세요.
              </p>
            )}
            <RecoverySetupFlow
              pattern={pattern}
              onSaved={() => {
                setMode("view");
                setNotice({
                  kind: "ok",
                  text: "회복 문구를 저장했어요. 잠금 화면의 ‘회복 문구로 열기’로 들어올 수 있어요.",
                });
              }}
              onCancel={() => setMode("view")}
              cancelLabel="취소"
            />
          </div>
        )}

        {envelopeQuery.isSuccess && mode !== "setup" && (
          <div className="mt-4">
            {hasRecovery ? (
              <>
                <p className="text-sm text-[var(--text)]">
                  회복 문구가 설정돼 있어요.
                  {createdAt && (
                    <span className="text-[var(--dim)]">
                      {" "}
                      {formatDateTime(createdAt)}에 만들었어요.
                    </span>
                  )}
                </p>
                {mode === "test" && (
                  <div className="mt-4 border-t border-[var(--border)] pt-4">
                    <RecoveryPhraseEntry
                      value={testInput}
                      onChange={setTestInput}
                      disabled={testBusy}
                      label="확인할 회복 문구"
                    />
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void runTest()}
                        disabled={testBusy}
                        className="min-h-11 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#161305] disabled:opacity-50"
                      >
                        {testBusy ? "확인하고 있어요…" : "이 문구로 열리는지 확인"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setMode("view");
                          setTestInput("");
                        }}
                        className="min-h-11 rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--text)]"
                      >
                        닫기
                      </button>
                    </div>
                  </div>
                )}
                {mode === "view" && (
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setMode("test");
                        setNotice(null);
                      }}
                      className="min-h-11 rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--text)]"
                    >
                      문구가 열리는지 확인하기
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMode("setup");
                        setNotice(null);
                      }}
                      className="min-h-11 rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--text)]"
                    >
                      새 문구로 바꾸기
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(true)}
                      className="min-h-11 rounded-lg border border-[var(--danger)] px-4 py-2 text-sm text-[var(--danger)]"
                    >
                      회복 문구 삭제
                    </button>
                  </div>
                )}
                {confirmDelete && (
                  <div
                    role="alertdialog"
                    aria-label="회복 문구 삭제 확인"
                    className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--danger)] px-4 py-3"
                  >
                    <p className="flex-1 text-sm leading-6 text-[var(--text)]">
                      회복 문구를 삭제할까요? 이후에는 패턴을 잊으면
                      금고와 백업을 열 방법이 없어요.
                    </p>
                    <button
                      type="button"
                      onClick={() => deleteMutation.mutate()}
                      disabled={deleteMutation.isPending}
                      className="min-h-11 rounded-lg bg-[var(--danger)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
                    >
                      {deleteMutation.isPending ? "삭제 중…" : "삭제하기"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      className="min-h-11 rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text)]"
                    >
                      취소
                    </button>
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="text-sm leading-6 text-[var(--text)]">
                  아직 회복 문구가 없어요. 지금 패턴을 잊으면 금고와
                  백업을 열 방법이 없으니, 문구를 만들어 종이에 적어
                  두는 걸 권해요.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setMode("setup");
                    setNotice(null);
                  }}
                  className="mt-3 min-h-11 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#161305]"
                >
                  회복 문구 만들기
                </button>
              </>
            )}
          </div>
        )}

        {notice && (
          <p
            role="alert"
            className={`mt-4 rounded-lg border px-4 py-3 text-sm leading-6 ${
              notice.kind === "err"
                ? "border-[var(--danger)] text-[var(--danger)]"
                : "border-[var(--accent)] text-[var(--text)]"
            }`}
          >
            {notice.text}
          </p>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- pattern upgrade ---------------------------- */

function UpgradeView({
  pattern,
  onDone,
  onCancel,
}: {
  pattern: number[];
  onDone: (newPattern: number[]) => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<"draw" | "confirm">("draw");
  const [first, setFirst] = useState<number[] | null>(null);
  const [message, setMessage] = useState(
    "새 5×5 패턴을 그려 주세요. 4개 이상의 점을 이어야 해요.",
  );
  const [error, setError] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const failTimer = useRef<number | null>(null);

  const fail = useCallback((msg: string) => {
    setError(true);
    setMessage(msg);
    if (failTimer.current) window.clearTimeout(failTimer.current);
    failTimer.current = window.setTimeout(() => {
      setError(false);
      setResetKey((k) => k + 1);
    }, 550);
  }, []);

  const mutation = useMutation({
    mutationFn: (newPattern: number[]) =>
      api.upgradePattern({ pattern, newPattern }),
    onSuccess: (res, newPattern) => {
      if (res.ok) onDone(newPattern);
      else if (res.error === "pattern_taken")
        fail("그 패턴은 이미 다른 금고를 여는 패턴이에요. 다른 패턴을 그려 주세요.");
      else fail("현재 패턴을 확인하지 못했어요. 금고를 잠갔다가 다시 열어 주세요.");
    },
    onError: () => fail("바꾸지 못했어요. 다시 시도해 주세요."),
  });

  const handleComplete = useCallback(
    (p: number[]) => {
      if (p.length < 4) {
        fail("4개 이상의 점을 이어 주세요.");
        return;
      }
      if (step === "draw") {
        setFirst(p);
        setStep("confirm");
        setMessage("확인을 위해 같은 패턴을 한 번 더 그려 주세요.");
        setResetKey((k) => k + 1);
        return;
      }
      const same =
        first !== null &&
        first.length === p.length &&
        first.every((v, i) => v === p[i]);
      if (!same) {
        setStep("draw");
        setFirst(null);
        fail("두 패턴이 달라요. 처음부터 다시 그려 주세요.");
        window.setTimeout(
          () => setMessage("새 5×5 패턴을 그려 주세요. 4개 이상의 점을 이어야 해요."),
          600,
        );
        return;
      }
      mutation.mutate(p);
    },
    [fail, first, mutation, step],
  );

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col items-center px-6 py-10">
      <h2 className="text-center text-xl font-semibold text-[var(--text)]">
        {step === "draw" ? "5×5 패턴으로 바꾸기" : "새 패턴 한 번 더 그리기"}
      </h2>
      <p
        className={`mt-2 min-h-6 text-center text-sm ${
          error ? "text-[var(--danger)]" : "text-[var(--dim)]"
        }`}
        role={error ? "alert" : undefined}
      >
        {message}
      </p>
      <div className="mt-4 flex w-full justify-center">
        <PatternPad
          grid={5}
          onComplete={handleComplete}
          error={error}
          disabled={mutation.isPending}
          resetKey={resetKey}
          label="새 5×5 패턴 그리기"
        />
      </div>
      <p className="mt-6 max-w-xs text-center text-xs leading-5 text-[var(--dim)]">
        바꾸고 나면 예전 패턴으로는 열 수 없어요. 예전 패턴으로 만든 백업도
        그 패턴으로만 복원할 수 있으니, 바꾸기 전에 필요한 백업이 있는지
        확인해 주세요. 회복 문구도 예전 패턴을 감싼 것이라 함께 무효가
        돼요. 바꾸고 나면 ‘회복’ 탭에서 새 문구를 만들어 주세요.
      </p>
      <button
        type="button"
        onClick={onCancel}
        className="mt-6 min-h-11 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm text-[var(--text)]"
      >
        나중에 하기
      </button>
    </div>
  );
}

/* ------------------------------- backup panel ----------------------------- */

function BackupPanel({
  pattern,
  vaultId,
  items,
}: {
  pattern: number[];
  vaultId: number;
  items: VaultItem[];
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);
  const restoreInputRef = useRef<HTMLInputElement>(null);
  // A freshly created backup package waits here until the user taps
  // the 저장 button: on mobile, a download triggered at the end of a
  // long async flow is no longer tied to a user gesture, so phones
  // silently drop it. The explicit tap is what makes the save work.
  const [pendingBackup, setPendingBackup] = useState<{
    name: string;
    json: string;
  } | null>(null);

  const backupsQuery = useQuery({
    queryKey: ["vault-backups", vaultId],
    queryFn: async () => {
      const res = await api.listBackups({ pattern });
      if (!res.ok) throw new Error("locked");
      return res.backups ?? [];
    },
  });
  const backups = backupsQuery.data ?? [];
  const head =
    backups.length > 0
      ? backups[backups.length - 1]!.blockHash
      : GENESIS_HASH;

  // Walk the chain the way a verifier would: every block must point at
  // the hash of the block before it, starting from the genesis hash.
  let chainBrokenAt = -1;
  for (let i = 0; i < backups.length; i++) {
    const expected = i === 0 ? GENESIS_HASH : backups[i - 1]!.blockHash;
    if (backups[i]!.prevHash !== expected) {
      chainBrokenAt = i;
      break;
    }
  }

  const createBackup = useCallback(async () => {
    if (items.length === 0) {
      setNotice({ kind: "err", text: "백업할 파일이 아직 없어요." });
      return;
    }
    setNotice(null);
    // Track the current step so a failure message can name where it
    // stopped instead of collapsing into a generic "try again".
    let step = "파일 읽기";
    try {
      setBusy("파일을 읽고 있어요…");
      const files: PlainBackupItem[] = [];
      for (const item of items) {
        // Primary path: the file's bytes come back through the action
        // channel (getItemData), the same channel uploads use. The old
        // flow fetched the blob URL from the browser instead — an extra
        // round-trip no other working feature depends on.
        let bytes: Uint8Array | null = null;
        const data = await api.getItemData({ pattern, id: item.id });
        if (data.ok && data.dataBase64) {
          bytes = base64ToBytes(data.dataBase64);
        } else {
          // Fallback: the blob URL, in case the byte channel is
          // unavailable in this runtime.
          const res = await api.getItemUrl({ pattern, id: item.id });
          if (res.ok && res.url) {
            const resp = await fetch(res.url);
            if (resp.ok) bytes = new Uint8Array(await resp.arrayBuffer());
          }
        }
        if (!bytes) {
          throw new Error(
            `'${item.name}' 파일의 내용을 읽지 못했어요` +
              (data.ok === false && data.error
                ? ` (${data.error})`
                : ""),
          );
        }
        files.push({ name: item.name, mimeType: item.mimeType, bytes });
      }
      step = "암호화";
      setBusy("패턴 키로 암호화하고 있어요…");
      const createdAt = new Date().toISOString();
      const { pkg, totalSize } = await buildBackupPackage({
        pattern,
        prevHash: head,
        createdAt,
        files,
      });
      step = "체인에 기록";
      setBusy("체인에 기록하고 있어요…");
      const json = JSON.stringify(pkg);
      const reg = await api.registerBackup({
        pattern,
        createdAt,
        prevHash: pkg.chain.prevHash,
        blockHash: pkg.chain.blockHash,
        itemHashes: pkg.items.map((i) => i.sha256),
        totalSize,
        packageJson: json,
      });
      if (!reg.ok) {
        setNotice({
          kind: "err",
          text:
            reg.error === "chain_mismatch"
              ? "체인 상태가 그사이 바뀌었어요. 잠시 뒤 다시 시도해 주세요."
              : reg.error === "too_large"
                ? "백업이 너무 커서 기록하지 못했어요."
                : `백업을 기록하지 못했어요. (${reg.error ?? "unknown"})`,
        });
        return;
      }
      setPendingBackup({
        name: `vault-backup-${createdAt.slice(0, 10)}.json`,
        json,
      });
      await queryClient.invalidateQueries({ queryKey: ["vault-backups"] });
      setNotice({
        kind: "ok",
        text: `백업 블록 #${reg.backup?.id ?? ""}을(를) 체인에 기록했어요. 아래 ‘백업 파일 저장하기’를 눌러 이 기기에 파일로도 보관하세요. 휴대폰에서는 공유 시트에서 ‘파일에 저장’을 선택하면 돼요.`,
      });
    } catch (e) {
      setNotice({
        kind: "err",
        text: `백업을 만들지 못했어요. ${step} 단계에서 멈췄어요: ${describeError(e)}`,
      });
    } finally {
      setBusy(null);
    }
  }, [head, items, pattern, queryClient]);

  const handleRestoreFile = useCallback(
    async (file: File) => {
      setNotice(null);
      try {
        setBusy("백업을 열고 검증하고 있어요…");
        const text = await file.text();
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          setNotice({ kind: "err", text: "백업 파일 형식이 아니에요." });
          return;
        }
        const opened = await openBackupPackage(raw, pattern);
        if (!opened.ok) {
          setNotice({
            kind: "err",
            text:
              opened.reason === "wrong_pattern"
                ? "지금 패턴으로는 이 백업을 열 수 없어요. 백업을 만들 때의 패턴이 필요해요."
                : opened.reason === "tampered"
                  ? "백업이 바뀐 흔적이 있어 복원을 멈췄어요. 해시가 맞지 않아요."
                  : opened.reason === "unsupported"
                    ? "이 백업은 예전 형식이라 지금 환경에서는 열 수 없어요. 새로 만든 백업은 이 환경에서도 열려요."
                    : "백업 파일 형식이 아니에요.",
          });
          return;
        }
        const existing = new Set(
          items.map((i) => `${i.name}:${i.size}`),
        );
        let added = 0;
        let skipped = 0;
        let failed = 0;
        for (const f of opened.files) {
          if (existing.has(`${f.name}:${f.bytes.length}`)) {
            skipped++;
            continue;
          }
          setBusy(`복원 중… ${added + skipped + failed + 1}/${opened.files.length}`);
          const res = await api.addItem({
            pattern,
            name: f.name,
            mimeType: f.mimeType || "application/octet-stream",
            dataBase64: bytesToBase64(f.bytes),
          });
          if (res.ok) added++;
          else failed++;
        }
        await queryClient.invalidateQueries({ queryKey: ["vault-items"] });
        const inChain = backups.some((b) => b.blockHash === opened.blockHash);
        setNotice({
          kind: "ok",
          text:
            `무결성 검증을 통과했어요${inChain ? " · 체인에 기록된 백업이에요" : ""}. ` +
            `${added}개 복원${skipped > 0 ? `, ${skipped}개는 이미 있어 건너뜀` : ""}` +
            `${failed > 0 ? `, ${failed}개는 넣지 못했어요` : ""}.`,
        });
      } catch (e) {
        setNotice({
          kind: "err",
          text: `복원하지 못했어요: ${describeError(e)}`,
        });
      } finally {
        setBusy(null);
      }
    },
    [backups, items, pattern, queryClient],
  );

  const savePendingBackup = useCallback(async () => {
    if (!pendingBackup) return;
    try {
      const outcome = await saveFileToDevice({
        name: pendingBackup.name,
        mimeType: "application/json",
        bytes: new TextEncoder().encode(pendingBackup.json),
      });
      setNotice({
        kind: "ok",
        text:
          outcome === "shared"
            ? "공유 시트에서 저장할 곳을 선택하면 백업 파일이 이 기기에 보관돼요."
            : "백업 파일 내려받기가 시작됐어요. 다운로드 폴더나 파일 앱에서 확인하세요.",
      });
      setPendingBackup(null);
    } catch (e) {
      setNotice({
        kind: "err",
        text: `백업 파일을 저장하지 못했어요: ${describeError(e)}`,
      });
    }
  }, [pendingBackup]);

  // Stored-block download, mobile-safe like every other export: pull
  // the package bytes through the action channel (getBackupData) and
  // save a local file, with the blob URL kept only as a fallback.
  const downloadStored = useCallback(
    async (entry: BackupEntry) => {
      setNotice(null);
      try {
        let bytes: Uint8Array | null = null;
        const data = await api.getBackupData({ pattern, id: entry.id });
        if (data.ok && data.dataBase64) {
          bytes = base64ToBytes(data.dataBase64);
        } else {
          const res = await api.getBackupUrl({ pattern, id: entry.id });
          if (res.ok && res.url) {
            const resp = await fetch(res.url);
            if (resp.ok) bytes = new Uint8Array(await resp.arrayBuffer());
          }
        }
        if (!bytes) {
          setNotice({
            kind: "err",
            text: "백업 파일을 읽지 못해서 내려받지 못했어요.",
          });
          return;
        }
        const outcome = await saveFileToDevice({
          name: `vault-backup-${entry.createdAt.slice(0, 10)}.json`,
          mimeType: "application/json",
          bytes,
        });
        setNotice({
          kind: "ok",
          text:
            outcome === "shared"
              ? "공유 시트에서 저장할 곳을 선택하면 백업 파일이 이 기기에 보관돼요."
              : "백업 파일 내려받기가 시작됐어요. 다운로드 폴더나 파일 앱에서 확인하세요.",
        });
      } catch (e) {
        setNotice({
          kind: "err",
          text: `백업 파일을 내려받지 못했어요: ${describeError(e)}`,
        });
      }
    },
    [pattern],
  );

  return (
    <div>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-5">
        <div className="flex items-start gap-3">
          <IconChain className="mt-0.5 h-6 w-6 shrink-0 text-[var(--accent)]" />
          <div>
            <h2 className="text-base font-semibold text-[var(--text)]">
              해시 체인 백업
            </h2>
            <p className="mt-1.5 text-sm leading-6 text-[var(--dim)]">
              백업을 만들 때마다 파일 전체를 지금 패턴에서 만든 키로
              암호화하고, 각 파일의 SHA-256 해시를 이전 백업의 해시와
              연결해 체인에 기록해요. 백업 파일이나 체인 중 하나라도
              바뀌면 복원할 때 해시가 맞지 않아 바로 알 수 있어요.
              암호화 키는 패턴뿐이라 패턴을 잊으면 백업도 열 수 없지만,
              회복 문구를 만들어 뒀다면 문구로 패턴을 되찾아 백업까지
              복원할 수 있어요.
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void createBackup()}
            disabled={busy !== null}
            className="flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#161305] disabled:opacity-50"
          >
            <IconChain className="h-4 w-4" />
            지금 백업 만들기
          </button>
          <button
            type="button"
            onClick={() => restoreInputRef.current?.click()}
            disabled={busy !== null}
            className="flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--text)] disabled:opacity-50"
          >
            <IconUpload className="h-4 w-4" />
            백업 파일로 복원
          </button>
          <input
            ref={restoreInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            aria-label="복원할 백업 파일 선택"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleRestoreFile(f);
              e.target.value = "";
            }}
          />
        </div>
        {busy && (
          <p className="mt-3 font-mono text-xs text-[var(--dim)]">{busy}</p>
        )}
        {pendingBackup && (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--accent)] px-4 py-3">
            <p className="flex-1 text-sm leading-6 text-[var(--text)]">
              백업 파일이 준비됐어요:{" "}
              <span className="font-mono text-xs">{pendingBackup.name}</span>
            </p>
            <button
              type="button"
              onClick={() => void savePendingBackup()}
              className="flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#161305]"
            >
              <IconShare className="h-4 w-4" />
              백업 파일 저장하기
            </button>
          </div>
        )}
        {notice && (
          <p
            role="alert"
            className={`mt-3 rounded-lg border px-4 py-3 text-sm ${
              notice.kind === "err"
                ? "border-[var(--danger)] text-[var(--danger)]"
                : "border-[var(--accent)] text-[var(--text)]"
            }`}
          >
            {notice.text}
          </p>
        )}
      </div>

      <h3 className="mt-8 text-sm font-semibold text-[var(--text)]">
        백업 체인
      </h3>
      {backupsQuery.isPending && (
        <p className="mt-3 font-mono text-xs text-[var(--dim)]">
          불러오는 중…
        </p>
      )}
      {backupsQuery.isError && (
        <p className="mt-3 text-sm text-[var(--danger)]">
          체인을 불러오지 못했어요.
        </p>
      )}
      {backupsQuery.isSuccess && backups.length === 0 && (
        <p className="mt-3 text-sm text-[var(--dim)]">
          아직 기록된 백업이 없어요. 첫 백업을 만들면 체인의 첫 블록이
          생겨요.
        </p>
      )}
      {chainBrokenAt >= 0 && (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-[var(--danger)] px-4 py-3 text-sm text-[var(--danger)]"
        >
          블록 #{backups[chainBrokenAt]?.id}에서 체인 연결이 끊겨 있어요.
          기록이 바뀐 흔적이에요.
        </p>
      )}
      {backups.length > 0 && (
        <ol className="mt-4">
          {[...backups].reverse().map((b) => (
            <li key={b.id} className="relative flex gap-3 pb-5 last:pb-0">
              <div className="flex flex-col items-center">
                <span className="mt-1 h-3 w-3 shrink-0 rounded-sm border-2 border-[var(--accent)] bg-[var(--surface)]" />
                <span className="w-px flex-1 bg-[var(--border)]" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-[var(--text)]">
                    블록 #{b.id}
                  </p>
                  <p className="font-mono text-xs text-[var(--dim)]">
                    {formatDateTime(b.createdAt)}
                  </p>
                  <span className="flex-1" />
                  <button
                    type="button"
                    onClick={() => void downloadStored(b)}
                    aria-label={`블록 ${b.id} 백업 파일 내려받기`}
                    className="flex min-h-11 items-center gap-1 rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text)]"
                  >
                    <IconDownload className="h-3.5 w-3.5" />
                    백업 파일
                  </button>
                </div>
                <p className="mt-1.5 font-mono text-xs text-[var(--dim)]">
                  파일 {b.itemCount}개 · {formatSize(b.totalSize)}
                </p>
                <p className="mt-1 truncate font-mono text-xs text-[var(--dim)]">
                  해시 {shortHash(b.blockHash)}
                </p>
                <p className="truncate font-mono text-xs text-[var(--dim)]">
                  이전 {b.prevHash === GENESIS_HASH ? "제네시스(첫 블록)" : shortHash(b.prevHash)}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/* ------------------------------ source viewer ----------------------------- */

// The app's own source code, read verbatim from the artifact's files on
// the server (getSourceCode) so what is shown is the code actually
// running — not a copy pasted into the bundle that could drift.
function SourcePanel() {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const sourceQuery = useQuery({
    queryKey: ["vault-source"],
    queryFn: async () => {
      const res = await api.getSourceCode({});
      return res.files;
    },
  });
  const files = sourceQuery.data ?? [];
  const selected =
    files.find((f) => f.path === selectedPath) ??
    files.find((f) => f.ok) ??
    null;

  return (
    <div>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-5">
        <div className="flex items-start gap-3">
          <IconCode className="mt-0.5 h-6 w-6 shrink-0 text-[var(--accent)]" />
          <div>
            <h2 className="text-base font-semibold text-[var(--text)]">
              앱 소스 코드
            </h2>
            <p className="mt-1.5 text-sm leading-6 text-[var(--dim)]">
              이 앱을 이루는 실제 소스 코드예요. 서버에 있는 앱 파일에서
              그대로 읽어 오기 때문에, 지금 실행 중인 코드와 항상 같아요.
              패턴 잠금, 파일 저장, 백업 암호화가 어떻게 동작하는지 직접
              확인할 수 있어요.
            </p>
          </div>
        </div>
      </div>

      {sourceQuery.isPending && (
        <p className="mt-4 font-mono text-xs text-[var(--dim)]">
          코드를 불러오는 중…
        </p>
      )}
      {sourceQuery.isError && (
        <div className="mt-4">
          <p role="alert" className="text-sm text-[var(--danger)]">
            코드를 불러오지 못했어요: {describeError(sourceQuery.error)}
          </p>
          <button
            type="button"
            onClick={() => void sourceQuery.refetch()}
            className="mt-3 min-h-11 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm text-[var(--text)]"
          >
            다시 시도
          </button>
        </div>
      )}
      {sourceQuery.isSuccess && files.length === 0 && (
        <p className="mt-4 text-sm text-[var(--dim)]">
          표시할 코드 파일이 없어요.
        </p>
      )}
      {files.length > 0 && (
        <>
          <div
            role="tablist"
            aria-label="코드 파일 선택"
            className="mt-4 flex flex-wrap gap-1.5"
          >
            {files.map((f) => (
              <button
                key={f.path}
                type="button"
                role="tab"
                aria-selected={selected?.path === f.path}
                onClick={() => setSelectedPath(f.path)}
                className={`min-h-11 rounded-lg px-3 py-2 font-mono text-xs ${
                  selected?.path === f.path
                    ? "bg-[var(--surface-2)] text-[var(--text)]"
                    : "text-[var(--dim)]"
                }`}
              >
                {f.path}
              </button>
            ))}
          </div>
          {selected && !selected.ok && (
            <p role="alert" className="mt-4 text-sm text-[var(--danger)]">
              이 파일은 읽지 못했어요. ({selected.path})
            </p>
          )}
          {selected && selected.ok && (
            <div className="mt-3 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              <p className="border-b border-[var(--border)] px-4 py-2 font-mono text-xs text-[var(--dim)]">
                {selected.path} · {selected.content.split("\n").length}줄 ·{" "}
                {formatSize(new TextEncoder().encode(selected.content).length)}
              </p>
              <pre className="max-h-[70vh] overflow-auto px-4 py-3 font-mono text-xs leading-5 text-[var(--text)]">
                {selected.content}
              </pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------ install panel ----------------------------- */

// The "모바일에서 다운로드" surface. Two honest halves:
//  - Files: every 꺼내기/백업 저장이 이제 공유 시트와 로컬 내려받기로
//    동작한다는 안내 (the actual mechanism lives in saveFileToDevice).
//  - The app itself: this is a home-screen web app, not an App Store /
//    Play Store binary, so "installing" it means adding it to the
//    home screen. Where the browser offers a real install prompt
//    (Android Chrome), the button fires it; on iPhone the steps are
//    listed because iOS offers no programmatic install.
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function useInstallPrompt() {
  const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(
    null,
  );
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as Navigator & { standalone?: boolean })
        .standalone === true;
    if (standalone) setInstalled(true);
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPromptEvent(e as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setPromptEvent(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  const runInstall = useCallback(async () => {
    if (!promptEvent) return false;
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    if (choice.outcome === "accepted") {
      setInstalled(true);
      setPromptEvent(null);
      return true;
    }
    return false;
  }, [promptEvent]);
  return { promptEvent, installed, runInstall };
}

function InstallPanel({
  install,
}: {
  install: ReturnType<typeof useInstallPrompt>;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <div>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-5">
        <div className="flex items-start gap-3">
          <IconPhone className="mt-0.5 h-6 w-6 shrink-0 text-[var(--accent)]" />
          <div>
            <h2 className="text-base font-semibold text-[var(--text)]">
              모바일에서 쓰기
            </h2>
            <p className="mt-1.5 text-sm leading-6 text-[var(--dim)]">
              이 금고는 앱스토어에서 받는 네이티브 앱이 아니라, 휴대폰
              홈 화면에 추가해 앱처럼 여는 웹 앱이에요. 파일 꺼내기와
              백업 저장은 휴대폰의 공유 시트와 다운로드로 동작하도록
              바꿨어요.
            </p>
          </div>
        </div>

        <div className="mt-5 border-t border-[var(--border)] pt-5">
          <h3 className="text-sm font-semibold text-[var(--text)]">
            1. 홈 화면에 추가하기
          </h3>
          {install.installed ? (
            <p className="mt-2 text-sm leading-6 text-[var(--text)]">
              지금 홈 화면 앱으로 실행 중이에요. 이미 설치된 상태예요.
            </p>
          ) : install.promptEvent ? (
            <>
              <p className="mt-2 text-sm leading-6 text-[var(--dim)]">
                이 브라우저는 바로 설치를 지원해요. 아래 버튼을 누르면
                홈 화면에 금고 아이콘이 생겨요.
              </p>
              <button
                type="button"
                onClick={() => {
                  void install.runInstall().then((ok) =>
                    setNotice(
                      ok
                        ? "설치했어요. 홈 화면의 금고 아이콘으로 열 수 있어요."
                        : "설치를 취소했어요. 브라우저 메뉴에서 ‘홈 화면에 추가’로도 할 수 있어요.",
                    ),
                  );
                }}
                className="mt-3 flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#161305]"
              >
                <IconDownload className="h-4 w-4" />
                홈 화면에 설치하기
              </button>
            </>
          ) : (
            <div className="mt-2 grid gap-4 sm:grid-cols-2">
              <div className="rounded-lg border border-[var(--border)] px-4 py-3">
                <p className="text-sm font-semibold text-[var(--text)]">
                  아이폰 (Safari)
                </p>
                <ol className="mt-1.5 list-decimal pl-5 text-sm leading-6 text-[var(--dim)]">
                  <li>이 페이지를 Safari로 열어요.</li>
                  <li>아래 공유 버튼을 눌러요.</li>
                  <li>‘홈 화면에 추가’를 선택해요.</li>
                </ol>
              </div>
              <div className="rounded-lg border border-[var(--border)] px-4 py-3">
                <p className="text-sm font-semibold text-[var(--text)]">
                  안드로이드 (Chrome)
                </p>
                <ol className="mt-1.5 list-decimal pl-5 text-sm leading-6 text-[var(--dim)]">
                  <li>오른쪽 위 ⋮ 메뉴를 열어요.</li>
                  <li>‘앱 설치’ 또는 ‘홈 화면에 추가’를 눌러요.</li>
                  <li>홈 화면의 금고 아이콘으로 열어요.</li>
                </ol>
              </div>
            </div>
          )}
          <p className="mt-3 text-xs leading-5 text-[var(--dim)]">
            앱 안에서 보고 있다면, 브라우저(Safari·Chrome)에서 이
            페이지를 연 뒤 위 순서대로 하면 홈 화면에 추가할 수 있어요.
          </p>
          {notice && (
            <p
              role="status"
              className="mt-3 rounded-lg border border-[var(--accent)] px-4 py-3 text-sm leading-6 text-[var(--text)]"
            >
              {notice}
            </p>
          )}
        </div>

        <div className="mt-5 border-t border-[var(--border)] pt-5">
          <h3 className="text-sm font-semibold text-[var(--text)]">
            2. 파일을 휴대폰에 저장하기
          </h3>
          <ul className="mt-2 list-disc pl-5 text-sm leading-6 text-[var(--dim)]">
            <li>
              파일을 열고 ‘꺼내기’를 누르면 공유 시트가 열려요. ‘파일에
              저장’을 고르면 파일 앱에, 사진·영상은 사진 앱으로 보낼
              수도 있어요.
            </li>
            <li>
              백업은 ‘백업’ 탭에서 만들고, ‘백업 파일 저장하기’를 눌러
              같은 방식으로 이 기기에 보관해요. 체인에 기록된 예전
              백업도 블록마다 ‘백업 파일’ 버튼으로 다시 받을 수 있어요.
            </li>
            <li>
              공유 시트가 안 뜨는 브라우저에서는 내려받기가 시작되고,
              파일은 다운로드 폴더에 저장돼요.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- vaults panel ----------------------------- */

// One vault per pattern: this panel is where the multi-vault shape
// becomes visible — but only from inside an opened vault. It lists
// every vault's name and file count, renames or deletes the current
// one, and starts the new-vault flow. Switching to another vault is
// just locking and drawing that vault's pattern: there is no master
// key, so no panel can open a vault whose pattern you don't draw.
function VaultsPanel({
  pattern,
  vault,
  onRenamed,
  onCreateVault,
  onDeleted,
}: {
  pattern: number[];
  vault: CurrentVault;
  onRenamed: (name: string) => void;
  onCreateVault: () => void;
  onDeleted: (remainingVaults: number) => void;
}) {
  const queryClient = useQueryClient();
  const [nameInput, setNameInput] = useState(vault.name);
  const [notice, setNotice] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const vaultsQuery = useQuery({
    queryKey: ["vault-list"],
    queryFn: async () => {
      const res = await api.listVaults({ pattern });
      if (!res.ok) throw new Error("locked");
      return res.vaults ?? [];
    },
  });
  const vaults = vaultsQuery.data ?? [];

  const renameMutation = useMutation({
    mutationFn: (name: string) => api.renameVault({ pattern, name }),
    onSuccess: (res, name) => {
      if (res.ok) {
        onRenamed(name);
        void queryClient.invalidateQueries({ queryKey: ["vault-list"] });
        setNotice({ kind: "ok", text: "금고 이름을 바꿨어요." });
      } else {
        setNotice({
          kind: "err",
          text: "이름을 바꾸지 못했어요. 패턴을 확인하지 못했어요.",
        });
      }
    },
    onError: (e) =>
      setNotice({
        kind: "err",
        text: `이름을 바꾸지 못했어요: ${describeError(e)}`,
      }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteVault({ pattern }),
    onSuccess: (res) => {
      if (res.ok) onDeleted(res.remainingVaults ?? 0);
      else
        setNotice({
          kind: "err",
          text: "금고를 삭제하지 못했어요. 패턴을 확인하지 못했어요.",
        });
    },
    onError: (e) =>
      setNotice({
        kind: "err",
        text: `금고를 삭제하지 못했어요: ${describeError(e)}`,
      }),
  });

  return (
    <div>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-5">
        <div className="flex items-start gap-3">
          <IconLock className="mt-0.5 h-6 w-6 shrink-0 text-[var(--accent)]" />
          <div>
            <h2 className="text-base font-semibold text-[var(--text)]">
              패턴마다 금고
            </h2>
            <p className="mt-1.5 text-sm leading-6 text-[var(--dim)]">
              패턴 하나가 금고 하나를 열어요. 다른 금고로 가려면
              잠갔다가 그 금고의 패턴을 그리면 되고, 잠금 화면에서 아직
              어떤 금고도 열지 않는 패턴을 그리면 그 패턴으로 새
              금고를 만들 수 있어요. 금고끼리는 파일·백업·회복 문구가
              서로 섞이지 않아요.
            </p>
          </div>
        </div>

        <div className="mt-5 border-t border-[var(--border)] pt-5">
          <h3 className="text-sm font-semibold text-[var(--text)]">
            지금 금고 이름
          </h3>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              maxLength={40}
              aria-label="금고 이름"
              className="min-h-11 flex-1 basis-48 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)]"
            />
            <button
              type="button"
              onClick={() => {
                const name = nameInput.trim();
                if (name) renameMutation.mutate(name);
              }}
              disabled={
                renameMutation.isPending ||
                nameInput.trim() === "" ||
                nameInput.trim() === vault.name
              }
              className="min-h-11 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#161305] disabled:opacity-50"
            >
              {renameMutation.isPending ? "바꾸는 중…" : "이름 바꾸기"}
            </button>
          </div>
        </div>

        <div className="mt-5 border-t border-[var(--border)] pt-5">
          <h3 className="text-sm font-semibold text-[var(--text)]">
            금고 목록
          </h3>
          {vaultsQuery.isPending && (
            <p className="mt-2 font-mono text-xs text-[var(--dim)]">
              불러오는 중…
            </p>
          )}
          {vaultsQuery.isError && (
            <div className="mt-2">
              <p role="alert" className="text-sm text-[var(--danger)]">
                금고 목록을 불러오지 못했어요.
              </p>
              <button
                type="button"
                onClick={() => void vaultsQuery.refetch()}
                className="mt-3 min-h-11 rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--text)]"
              >
                다시 시도
              </button>
            </div>
          )}
          {vaultsQuery.isSuccess && (
            <ul className="mt-3 grid gap-2">
              {vaults.map((v) => (
                <li
                  key={v.id}
                  className={`flex flex-wrap items-center gap-2 rounded-lg border px-4 py-3 ${
                    v.id === vault.id
                      ? "border-[var(--accent)]"
                      : "border-[var(--border)]"
                  }`}
                >
                  <p className="flex-1 text-sm font-medium text-[var(--text)]">
                    {v.name}
                    {v.id === vault.id && (
                      <span className="ml-2 font-mono text-xs text-[var(--accent)]">
                        지금 열려 있어요
                      </span>
                    )}
                  </p>
                  <p className="font-mono text-xs text-[var(--dim)]">
                    파일 {v.itemCount}개 · {v.gridSize}×{v.gridSize} 패턴
                    {v.hasRecovery ? " · 회복 문구 있음" : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={onCreateVault}
            className="mt-4 flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#161305]"
          >
            <IconPlus className="h-4 w-4" />새 패턴으로 금고 만들기
          </button>
          <p className="mt-2 text-xs leading-5 text-[var(--dim)]">
            새 금고를 만들면 지금 금고는 잠기고, 새 패턴을 두 번 그어
            확인한 뒤 그 금고가 열려요.
          </p>
        </div>

        <div className="mt-5 border-t border-[var(--border)] pt-5">
          <h3 className="text-sm font-semibold text-[var(--danger)]">
            이 금고 삭제
          </h3>
          <p className="mt-1.5 text-sm leading-6 text-[var(--dim)]">
            ‘{vault.name}’ 금고와 그 안의 파일, 백업 기록을 모두
            지워요. 다른 금고는 그대로 남아요. 되돌릴 수 없어요.
          </p>
          {confirmDelete ? (
            <div
              role="alertdialog"
              aria-label="금고 삭제 확인"
              className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--danger)] px-4 py-3"
            >
              <p className="flex-1 text-sm leading-6 text-[var(--text)]">
                정말 이 금고를 삭제할까요?
              </p>
              <button
                type="button"
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
                className="min-h-11 rounded-lg bg-[var(--danger)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {deleteMutation.isPending ? "삭제 중…" : "금고 삭제하기"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="min-h-11 rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text)]"
              >
                취소
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="mt-3 min-h-11 rounded-lg border border-[var(--danger)] px-4 py-2 text-sm text-[var(--danger)]"
            >
              이 금고 삭제하기
            </button>
          )}
        </div>

        {notice && (
          <p
            role="alert"
            className={`mt-4 rounded-lg border px-4 py-3 text-sm leading-6 ${
              notice.kind === "err"
                ? "border-[var(--danger)] text-[var(--danger)]"
                : "border-[var(--accent)] text-[var(--text)]"
            }`}
          >
            {notice.text}
          </p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------ new vault view ---------------------------- */

// Create a vault for a pattern. Two entries: from the locked screen,
// where the user just drew a pattern no vault uses (confirm that same
// pattern once more and name the vault), and from inside a vault,
// where a fresh pattern is drawn twice like first-run setup. Either
// way the pattern is confirmed by a second identical draw before the
// server stores anything.
function NewVaultView({
  initialPattern,
  onCreated,
  onCancel,
}: {
  initialPattern: number[] | null;
  onCreated: (pattern: number[], vault: CurrentVault) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [step, setStep] = useState<"draw" | "confirm">(
    initialPattern ? "confirm" : "draw",
  );
  const [first, setFirst] = useState<number[] | null>(initialPattern);
  const [message, setMessage] = useState(
    initialPattern
      ? "방금 그린 패턴을 한 번 더 그려 확인해 주세요."
      : "새 금고의 5×5 패턴을 그려 주세요. 4개 이상의 점을 이어야 해요.",
  );
  const [error, setError] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const failTimer = useRef<number | null>(null);

  const fail = useCallback((msg: string) => {
    setError(true);
    setMessage(msg);
    if (failTimer.current) window.clearTimeout(failTimer.current);
    failTimer.current = window.setTimeout(() => {
      setError(false);
      setResetKey((k) => k + 1);
    }, 550);
  }, []);

  const create = useCallback(
    async (p: number[]) => {
      setBusy(true);
      try {
        const res = await api.setupPattern({
          pattern: p,
          name: name.trim() === "" ? undefined : name.trim(),
        });
        if (!res.ok || res.vaultId == null) {
          fail(
            res.error === "pattern_taken"
              ? "그 패턴은 이미 다른 금고를 여는 패턴이에요. 처음부터 다른 패턴을 그려 주세요."
              : "금고를 만들지 못했어요. 다시 시도해 주세요.",
          );
          setStep(initialPattern ? "confirm" : "draw");
          setFirst(initialPattern);
          return;
        }
        onCreated(p, {
          id: res.vaultId,
          name: res.vaultName ?? "내 금고",
          gridSize: 5,
        });
      } catch (e) {
        fail(`금고를 만들지 못했어요: ${describeError(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [fail, initialPattern, name, onCreated],
  );

  const handleComplete = useCallback(
    (p: number[]) => {
      if (p.length < 4) {
        fail("4개 이상의 점을 이어 주세요.");
        return;
      }
      if (step === "draw") {
        setFirst(p);
        setStep("confirm");
        setMessage("확인을 위해 같은 패턴을 한 번 더 그려 주세요.");
        setResetKey((k) => k + 1);
        return;
      }
      const same =
        first !== null &&
        first.length === p.length &&
        first.every((v, i) => v === p[i]);
      if (!same) {
        if (initialPattern) {
          fail("방금 잠금 화면에서 그린 패턴과 달라요. 같은 패턴을 그려 주세요.");
          return;
        }
        setStep("draw");
        setFirst(null);
        fail("두 패턴이 달라요. 처음부터 다시 그려 주세요.");
        window.setTimeout(
          () =>
            setMessage(
              "새 금고의 5×5 패턴을 그려 주세요. 4개 이상의 점을 이어야 해요.",
            ),
          600,
        );
        return;
      }
      void create(p);
    },
    [create, fail, first, initialPattern, step],
  );

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 pt-safe pb-safe">
      <div className="flex w-full max-w-sm flex-col items-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)]">
          <IconLock className="h-6 w-6 text-[var(--accent)]" />
        </div>
        <h1 className="mt-6 text-center text-2xl font-semibold text-[var(--text)]">
          새 금고 만들기
        </h1>
        <p
          className={`mt-2 min-h-6 text-center text-sm ${
            error ? "text-[var(--danger)]" : "text-[var(--dim)]"
          }`}
          role={error ? "alert" : undefined}
        >
          {message}
        </p>
        <div className="mt-4 w-full">
          <label
            htmlFor="new-vault-name"
            className="text-sm font-medium text-[var(--text)]"
          >
            금고 이름 (선택)
          </label>
          <input
            id="new-vault-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            placeholder="예: 가족 사진, 서류"
            className="mt-1.5 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-base text-[var(--text)]"
          />
          <p className="mt-1.5 text-xs leading-5 text-[var(--dim)]">
            이름은 금고를 연 뒤에만 보여요. 잠금 화면에서는 어떤
            금고가 있는지도 드러나지 않아요.
          </p>
        </div>
        <div className="mt-2 flex w-full justify-center">
          <PatternPad
            grid={5}
            onComplete={handleComplete}
            error={error}
            disabled={busy}
            resetKey={resetKey}
            label="새 금고 패턴 그리기"
          />
        </div>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="mt-6 flex min-h-11 items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm text-[var(--text)] disabled:opacity-50"
        >
          <IconBack className="h-4 w-4" />
          취소
        </button>
      </div>
    </div>
  );
}

/* -------------------------------- vault home ------------------------------ */

const MAX_BYTES = 25 * 1024 * 1024;

function VaultHome({
  pattern,
  vault,
  onLock,
  onUpgraded,
  onRenamed,
  onCreateVault,
  onVaultDeleted,
}: {
  pattern: number[];
  vault: CurrentVault;
  onLock: () => void;
  onUpgraded: (newPattern: number[]) => void;
  onRenamed: (name: string) => void;
  onCreateVault: () => void;
  onVaultDeleted: (remainingVaults: number) => void;
}) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busyCount, setBusyCount] = useState(0);
  const [view, setView] = useState<
    "files" | "backup" | "recovery" | "vaults" | "code" | "install"
  >("files");
  const install = useInstallPrompt();
  const [upgrading, setUpgrading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const itemsQuery = useQuery({
    queryKey: ["vault-items", vault.id],
    queryFn: async () => {
      const res = await api.listItems({ pattern });
      if (!res.ok) throw new Error("locked");
      return res.items ?? [];
    },
  });

  const addMutation = useMutation({
    mutationFn: (input: {
      name: string;
      mimeType: string;
      dataBase64: string;
    }) => api.addItem({ pattern, ...input }),
  });

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      const problems: string[] = [];
      for (const file of list) {
        if (file.size > MAX_BYTES) {
          problems.push(`'${file.name}'은 25MB를 넘어 넣을 수 없어요.`);
          continue;
        }
        setBusyCount((c) => c + 1);
        try {
          const { dataBase64, mimeType } = await fileToBase64(file);
          const res = await addMutation.mutateAsync({
            name: file.name,
            mimeType: file.type || mimeType || "application/octet-stream",
            dataBase64,
          });
          if (!res.ok) problems.push(`'${file.name}'을 넣지 못했어요.`);
        } catch {
          problems.push(`'${file.name}'을 넣지 못했어요.`);
        } finally {
          setBusyCount((c) => c - 1);
        }
      }
      setNotice(problems.length > 0 ? problems.join(" ") : null);
      await queryClient.invalidateQueries({ queryKey: ["vault-items"] });
    },
    [addMutation, queryClient],
  );

  const items = itemsQuery.data ?? [];
  const selected = items.find((i) => i.id === selectedId) ?? null;
  const totalSize = items.reduce((sum, i) => sum + i.size, 0);

  if (selected) {
    return (
      <ItemViewer
        pattern={pattern}
        item={selected}
        onBack={() => setSelectedId(null)}
        onDeleted={() => setSelectedId(null)}
      />
    );
  }

  if (upgrading) {
    return (
      <UpgradeView
        pattern={pattern}
        onDone={(newPattern) => {
          setUpgrading(false);
          onUpgraded(newPattern);
        }}
        onCancel={() => setUpgrading(false)}
      />
    );
  }

  return (
    <div
      className="relative min-h-dvh"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        void handleFiles(e.dataTransfer.files);
      }}
    >
      <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg)] pt-safe">
        <div className="mx-auto flex w-full max-w-4xl items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-semibold text-[var(--text)]">
              {vault.name}
            </p>
            <p className="font-mono text-xs text-[var(--dim)]">
              {itemsQuery.isPending
                ? "불러오는 중…"
                : `파일 ${items.length}개 · ${formatSize(totalSize)}`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3.5 py-2 text-sm font-semibold text-[#161305]"
          >
            <IconPlus className="h-4 w-4" />
            넣기
          </button>
          <button
            type="button"
            onClick={onLock}
            aria-label="금고 잠그기"
            className="flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-sm text-[var(--text)]"
          >
            <IconLock className="h-4 w-4" />
            잠그기
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            aria-label="금고에 넣을 파일 선택"
            onChange={(e) => {
              if (e.target.files) void handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        <div
          role="tablist"
          aria-label="금고 화면 전환"
          className="mx-auto flex w-full max-w-4xl gap-1 px-4 pb-2"
        >
          <button
            type="button"
            role="tab"
            aria-selected={view === "files"}
            onClick={() => setView("files")}
            className={`min-h-11 flex-1 rounded-lg px-3 py-2 text-sm font-medium ${
              view === "files"
                ? "bg-[var(--surface-2)] text-[var(--text)]"
                : "text-[var(--dim)]"
            }`}
          >
            파일
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "backup"}
            onClick={() => setView("backup")}
            className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium ${
              view === "backup"
                ? "bg-[var(--surface-2)] text-[var(--text)]"
                : "text-[var(--dim)]"
            }`}
          >
            <IconChain className="h-4 w-4" />
            백업
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "recovery"}
            onClick={() => setView("recovery")}
            className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium ${
              view === "recovery"
                ? "bg-[var(--surface-2)] text-[var(--text)]"
                : "text-[var(--dim)]"
            }`}
          >
            <IconKey className="h-4 w-4" />
            회복
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "vaults"}
            onClick={() => setView("vaults")}
            className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium ${
              view === "vaults"
                ? "bg-[var(--surface-2)] text-[var(--text)]"
                : "text-[var(--dim)]"
            }`}
          >
            <IconLock className="h-4 w-4" />
            금고
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "code"}
            onClick={() => setView("code")}
            className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium ${
              view === "code"
                ? "bg-[var(--surface-2)] text-[var(--text)]"
                : "text-[var(--dim)]"
            }`}
          >
            <IconCode className="h-4 w-4" />
            코드
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "install"}
            onClick={() => setView("install")}
            className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium ${
              view === "install"
                ? "bg-[var(--surface-2)] text-[var(--text)]"
                : "text-[var(--dim)]"
            }`}
          >
            <IconPhone className="h-4 w-4" />
            설치
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl px-4 pb-12 pb-safe">
        {view === "backup" ? (
          <div className="mt-5">
            <BackupPanel pattern={pattern} vaultId={vault.id} items={items} />
          </div>
        ) : view === "vaults" ? (
          <div className="mt-5">
            <VaultsPanel
              pattern={pattern}
              vault={vault}
              onRenamed={onRenamed}
              onCreateVault={onCreateVault}
              onDeleted={onVaultDeleted}
            />
          </div>
        ) : view === "recovery" ? (
          <div className="mt-5">
            <RecoveryPanel pattern={pattern} />
          </div>
        ) : view === "code" ? (
          <div className="mt-5">
            <SourcePanel />
          </div>
        ) : view === "install" ? (
          <div className="mt-5">
            <InstallPanel install={install} />
          </div>
        ) : (
          <>
            {vault.gridSize < 5 && (
              <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--accent)] bg-[var(--surface)] px-4 py-3">
                <p className="flex-1 text-sm leading-6 text-[var(--text)]">
                  아직 예전 3×3 패턴을 쓰고 있어요. 5×5 패턴으로 바꾸면
                  경우의 수가 크게 늘어나 더 안전해요.
                </p>
                <button
                  type="button"
                  onClick={() => setUpgrading(true)}
                  className="min-h-11 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#161305]"
                >
                  5×5로 바꾸기
                </button>
              </div>
            )}
            {notice && (
              <p
                role="alert"
                className="mt-4 rounded-lg border border-[var(--danger)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--danger)]"
              >
                {notice}
              </p>
            )}
            {busyCount > 0 && (
              <p className="mt-4 font-mono text-xs text-[var(--dim)]">
                넣는 중… 남은 파일 {busyCount}개
              </p>
            )}

            {itemsQuery.isError && (
              <div className="mt-16 text-center">
                <p className="text-sm text-[var(--danger)]">
                  금고 내용을 불러오지 못했어요.
                </p>
                <button
                  type="button"
                  onClick={() => itemsQuery.refetch()}
                  className="mt-3 min-h-11 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm text-[var(--text)]"
                >
                  다시 시도
                </button>
              </div>
            )}

            {itemsQuery.isSuccess && items.length === 0 && (
              <div className="mt-14 flex flex-col items-center rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)] px-6 py-16 text-center">
                <IconLock className="h-10 w-10 text-[var(--accent)]" />
                <p className="mt-4 text-lg font-medium text-[var(--text)]">
                  아직 금고가 비어 있어요
                </p>
                <p className="mt-2 max-w-sm text-sm leading-6 text-[var(--dim)]">
                  사진이나 파일을 넣어 보세요. 데스크톱에서는 파일을 이
                  화면으로 끌어다 놓아도 들어갑니다. 원본은 그대로 두고,
                  금고 안에는 복사본이 보관돼요.
                </p>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="mt-6 flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-[#161305]"
                >
                  <IconPlus className="h-4 w-4" />
                  첫 파일 넣기
                </button>
              </div>
            )}

            {items.length > 0 && (
              <ul className="mt-5 grid grid-cols-2 gap-3 pb-safe sm:grid-cols-3 md:grid-cols-4">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(item.id)}
                      aria-label={`${item.name} 보기`}
                      className="block w-full overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] text-left"
                    >
                      <div className="aspect-square bg-[var(--surface-2)]">
                        <ItemThumb pattern={pattern} item={item} />
                      </div>
                      <div className="px-3 py-2.5">
                        <p className="truncate text-sm font-medium text-[var(--text)]">
                          {item.name}
                        </p>
                        <p className="mt-0.5 font-mono text-xs text-[var(--dim)]">
                          {formatSize(item.size)} · {formatDate(item.createdAt)}
                        </p>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </main>

      {dragOver && (
        <div className="pointer-events-none fixed inset-3 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-[var(--accent)] bg-[var(--bg)]/85">
          <p className="text-lg font-semibold text-[var(--accent)]">
            놓으면 금고에 들어가요
          </p>
        </div>
      )}
    </div>
  );
}

/* ----------------------------------- app ---------------------------------- */

export function App() {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>("boot");
  const [pattern, setPattern] = useState<number[] | null>(null);
  const [vault, setVault] = useState<CurrentVault | null>(null);
  const [padReset, setPadReset] = useState(0);
  const [padError, setPadError] = useState(false);
  const [message, setMessage] = useState("");
  const [setupStep, setSetupStep] = useState<"draw" | "confirm">("draw");
  const [firstPattern, setFirstPattern] = useState<number[] | null>(null);
  const [setupName, setSetupName] = useState("");
  // A pattern drawn on the locked screen that no vault uses. It is
  // kept only so the user can turn it into a new vault with one more
  // confirming draw; it is not an error by itself any more — with one
  // vault per pattern, an unknown pattern is how new vaults begin.
  const [unknownPattern, setUnknownPattern] = useState<number[] | null>(
    null,
  );
  const [createInitial, setCreateInitial] = useState<number[] | null>(
    null,
  );
  const [showRecoveryUnlock, setShowRecoveryUnlock] = useState(false);
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  const install = useInstallPrompt();
  const failTimer = useRef<number | null>(null);

  const statusQuery = useQuery({
    queryKey: ["vault-status"],
    queryFn: () => api.getStatus({}),
  });
  const vaultCount = statusQuery.data?.vaultCount ?? 0;
  const lockGrid = statusQuery.data?.gridSize ?? 5;

  useEffect(() => {
    if (phase === "boot" && statusQuery.data) {
      setPhase(statusQuery.data.vaultCount > 0 ? "locked" : "setup");
      setMessage(
        statusQuery.data.vaultCount > 0
          ? "패턴을 그려서 그 패턴의 금고를 여세요."
          : "4개 이상의 점을 이어 첫 금고의 패턴을 만드세요.",
      );
    }
  }, [phase, statusQuery.data]);

  const lockVault = useCallback(() => {
    setPattern(null);
    setVault(null);
    setPhase("locked");
    setShowRecoveryUnlock(false);
    setUnknownPattern(null);
    setCreateInitial(null);
    setPadError(false);
    setMessage("패턴을 그려서 그 패턴의 금고를 여세요.");
    setPadReset((k) => k + 1);
    queryClient.removeQueries({ queryKey: ["vault-items"] });
    queryClient.removeQueries({ queryKey: ["vault-backups"] });
    queryClient.removeQueries({ queryKey: ["vault-list"] });
    queryClient.removeQueries({ queryKey: ["item-url"] });
    queryClient.removeQueries({ queryKey: ["recovery-own"] });
  }, [queryClient]);

  // Auto-lock: leaving the page (tab hidden) seals the vault at once, and
  // five idle minutes seal it too. The pattern lives only in this state.
  useEffect(() => {
    if (phase !== "unlocked") return;
    let timer: number | undefined;
    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(lockVault, 5 * 60 * 1000);
    };
    const onVisibility = () => {
      if (document.hidden) lockVault();
      else arm();
    };
    arm();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pointerdown", arm);
    window.addEventListener("keydown", arm);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
    };
  }, [phase, lockVault]);

  const failPad = useCallback((msg: string) => {
    setPadError(true);
    setMessage(msg);
    if (failTimer.current) window.clearTimeout(failTimer.current);
    failTimer.current = window.setTimeout(() => {
      setPadError(false);
      setPadReset((k) => k + 1);
    }, 550);
  }, []);

  const setupMutation = useMutation({
    mutationFn: (p: number[]) =>
      api.setupPattern({
        pattern: p,
        name: setupName.trim() === "" ? undefined : setupName.trim(),
      }),
    onSuccess: (res, p) => {
      if (res.ok && res.vaultId != null) {
        void queryClient.invalidateQueries({ queryKey: ["vault-status"] });
        setVault({
          id: res.vaultId,
          name: res.vaultName ?? "내 금고",
          gridSize: 5,
        });
        setPattern(p);
        // Straight after the pattern comes the recovery phrase: the
        // one moment the user is guaranteed to still know the pattern.
        // It can be skipped and made later from the 회복 tab.
        setPhase("recoverySetup");
      } else {
        failPad(
          "그 패턴은 이미 금고를 여는 패턴이에요. 처음부터 다른 패턴을 그려 주세요.",
        );
        setSetupStep("draw");
        setFirstPattern(null);
      }
    },
    onError: () => failPad("패턴을 저장하지 못했어요. 다시 시도해 주세요."),
  });

  const unlockMutation = useMutation({
    mutationFn: (p: number[]) => api.unlock({ pattern: p }),
    onSuccess: (res, p) => {
      if (res.ok && res.vaultId != null) {
        setUnknownPattern(null);
        setVault({
          id: res.vaultId,
          name: res.vaultName ?? "내 금고",
          gridSize: res.gridSize ?? 5,
        });
        setPattern(p);
        setPhase("unlocked");
        setMessage("");
      } else {
        // No vault uses this pattern. That is not just a wrong draw
        // any more: offer to make this pattern a new vault (one more
        // confirming draw in the create view), or redraw to retry.
        setUnknownPattern(p);
        failPad(
          "이 패턴으로 열리는 금고가 없어요. 다시 그리거나, 아래에서 이 패턴으로 새 금고를 만들 수 있어요.",
        );
      }
    },
    onError: () => failPad("확인하지 못했어요. 다시 시도해 주세요."),
  });

  const handleSetupComplete = useCallback(
    (p: number[]) => {
      if (p.length < 4) {
        failPad("4개 이상의 점을 이어 주세요.");
        return;
      }
      if (setupStep === "draw") {
        setFirstPattern(p);
        setSetupStep("confirm");
        setMessage("확인을 위해 같은 패턴을 한 번 더 그려 주세요.");
        setPadReset((k) => k + 1);
        return;
      }
      const same =
        firstPattern !== null &&
        firstPattern.length === p.length &&
        firstPattern.every((v, i) => v === p[i]);
      if (!same) {
        setSetupStep("draw");
        setFirstPattern(null);
        failPad("두 패턴이 달라요. 처음부터 다시 그려 주세요.");
        window.setTimeout(
          () => setMessage("4개 이상의 점을 이어 금고 패턴을 만드세요."),
          600,
        );
        return;
      }
      setupMutation.mutate(p);
    },
    [failPad, firstPattern, setupMutation, setupStep],
  );

  const handleUnlockComplete = useCallback(
    (p: number[]) => {
      if (p.length < 4) {
        failPad("패턴이 맞지 않아요. 다시 그려 보세요.");
        return;
      }
      unlockMutation.mutate(p);
    },
    [failPad, unlockMutation],
  );

  if (statusQuery.isError) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-[var(--bg)] px-6 text-center">
        <p className="text-sm text-[var(--danger)]">
          금고 상태를 확인하지 못했어요.
        </p>
        <button
          type="button"
          onClick={() => statusQuery.refetch()}
          className="mt-3 min-h-11 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm text-[var(--text)]"
        >
          다시 시도
        </button>
      </div>
    );
  }

  if (phase === "boot" || statusQuery.isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[var(--bg)] px-6">
        <p className="font-mono text-sm text-[var(--dim)]">
          금고를 확인하고 있어요…
        </p>
      </div>
    );
  }

  if (showInstallGuide) {
    return (
      <div className="min-h-dvh bg-[var(--bg)] text-[var(--text)]">
        <div className="mx-auto w-full max-w-2xl px-4 py-6 pt-safe pb-safe">
          <button
            type="button"
            onClick={() => setShowInstallGuide(false)}
            className="flex min-h-11 items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
          >
            <IconBack className="h-4 w-4" />
            금고로 돌아가기
          </button>
          <div className="mt-4">
            <InstallPanel install={install} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--text)]">
      {phase === "setup" && (
        <LockScreen
          title={
            setupStep === "draw" ? "첫 금고 패턴 만들기" : "패턴 한 번 더 그리기"
          }
          message={message}
          error={padError}
          busy={setupMutation.isPending}
          resetKey={padReset}
          grid={5}
          onComplete={handleSetupComplete}
          extra={
            setupStep === "draw" ? (
              <div className="mt-2 w-full">
                <label
                  htmlFor="setup-vault-name"
                  className="text-sm font-medium text-[var(--text)]"
                >
                  금고 이름 (선택)
                </label>
                <input
                  id="setup-vault-name"
                  type="text"
                  value={setupName}
                  onChange={(e) => setSetupName(e.target.value)}
                  maxLength={40}
                  placeholder="예: 가족 사진, 서류"
                  className="mt-1.5 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-base text-[var(--text)]"
                />
              </div>
            ) : undefined
          }
          footnote="5×5 패턴이에요. 패턴 자체는 저장되지 않고 확인용 해시만 보관되며, 이 패턴이 백업을 여는 열쇠도 돼요. 패턴마다 금고가 따로 생기니, 나중에는 다른 패턴으로 금고를 더 만들 수 있어요. 패턴을 만든 다음에는 패턴을 잊었을 때를 대비한 회복 문구도 이어서 만들게요."
          onShowInstall={() => setShowInstallGuide(true)}
        />
      )}
      {phase === "createVault" && (
        <NewVaultView
          initialPattern={createInitial}
          onCreated={(p, created) => {
            void queryClient.invalidateQueries({
              queryKey: ["vault-status"],
            });
            setCreateInitial(null);
            setUnknownPattern(null);
            setVault(created);
            setPattern(p);
            setPhase("recoverySetup");
          }}
          onCancel={() => {
            setCreateInitial(null);
            if (pattern && vault) {
              setPhase("unlocked");
            } else {
              setPhase(vaultCount > 0 ? "locked" : "setup");
              setMessage("패턴을 그려서 그 패턴의 금고를 여세요.");
              setPadReset((k) => k + 1);
            }
          }}
        />
      )}
      {phase === "recoverySetup" && pattern && (
        <div className="flex min-h-dvh flex-col items-center justify-center px-6 pt-safe pb-safe">
          <div className="w-full max-w-md">
            <div className="flex flex-col items-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)]">
                <IconKey className="h-6 w-6 text-[var(--accent)]" />
              </div>
              <h1 className="mt-6 text-center text-2xl font-semibold text-[var(--text)]">
                회복 문구 만들기
              </h1>
              <p className="mt-2 text-center text-sm text-[var(--dim)]">
                패턴이 완성됐어요. 이제 패턴을 잊었을 때를 대비해요.
              </p>
            </div>
            <div className="mt-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-5">
              <RecoverySetupFlow
                pattern={pattern}
                onSaved={() => setPhase("unlocked")}
                onCancel={() => setPhase("unlocked")}
                cancelLabel="나중에 하기"
              />
            </div>
          </div>
        </div>
      )}
      {phase === "locked" && showRecoveryUnlock && (
        <RecoveryUnlockView
          onBack={() => setShowRecoveryUnlock(false)}
          onRecovered={(recovered, recoveredVault) => {
            setShowRecoveryUnlock(false);
            setPattern(recovered);
            setVault(recoveredVault);
            setPhase("unlocked");
            setMessage("");
          }}
        />
      )}
      {phase === "locked" && !showRecoveryUnlock && (
        <LockScreen
          title="금고가 잠겨 있어요"
          message={message}
          error={padError}
          busy={unlockMutation.isPending}
          resetKey={padReset}
          grid={lockGrid}
          onComplete={handleUnlockComplete}
          belowPad={
            unknownPattern ? (
              <div className="mt-6 w-full rounded-xl border border-[var(--accent)] bg-[var(--surface)] px-4 py-4">
                <p className="text-sm leading-6 text-[var(--text)]">
                  방금 그린 패턴으로 열리는 금고가 없어요. 패턴을 잘못
                  그렸다면 위에서 다시 그리면 되고, 새 금고를 만들
                  패턴이라면 한 번 더 그어 확인하고 이름을 붙여 만들
                  수 있어요.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setCreateInitial(unknownPattern);
                    setPhase("createVault");
                  }}
                  className="mt-3 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#161305]"
                >
                  <IconPlus className="h-4 w-4" />
                  이 패턴으로 새 금고 만들기
                </button>
              </div>
            ) : undefined
          }
          recovery={{
            hasRecovery: statusQuery.data?.hasRecovery ?? false,
            onOpen: () => setShowRecoveryUnlock(true),
          }}
          footnote={
            lockGrid < 5
              ? "예전 3×3 패턴으로 여는 중이에요. 열면 5×5 패턴으로 바꿀 수 있어요. 힌트는 없어요."
              : `지금 금고가 ${vaultCount}개 있어요. 그리는 패턴에 따라 열리는 금고가 달라져요. 힌트는 없어요.`
          }
          onShowInstall={() => setShowInstallGuide(true)}
        />
      )}
      {phase === "unlocked" && pattern && vault && (
        <VaultHome
          pattern={pattern}
          vault={vault}
          onLock={lockVault}
          onUpgraded={(newPattern) => {
            setPattern(newPattern);
            setVault((v) => (v ? { ...v, gridSize: 5 } : v));
            void queryClient.invalidateQueries({
              queryKey: ["vault-status"],
            });
          }}
          onRenamed={(name) => setVault((v) => (v ? { ...v, name } : v))}
          onCreateVault={() => {
            setCreateInitial(null);
            setPhase("createVault");
          }}
          onVaultDeleted={(remaining) => {
            void queryClient.invalidateQueries({
              queryKey: ["vault-status"],
            });
            setPattern(null);
            setVault(null);
            setUnknownPattern(null);
            setPhase(remaining > 0 ? "locked" : "setup");
            setSetupStep("draw");
            setFirstPattern(null);
            setMessage(
              remaining > 0
                ? "금고를 삭제했어요. 패턴을 그려서 그 패턴의 금고를 여세요."
                : "금고를 삭제했어요. 4개 이상의 점을 이어 첫 금고의 패턴을 만드세요.",
            );
            setPadReset((k) => k + 1);
            queryClient.removeQueries({ queryKey: ["vault-items"] });
            queryClient.removeQueries({ queryKey: ["vault-backups"] });
            queryClient.removeQueries({ queryKey: ["vault-list"] });
            queryClient.removeQueries({ queryKey: ["item-url"] });
            queryClient.removeQueries({ queryKey: ["recovery-own"] });
          }}
        />
      )}
    </div>
  );
}
