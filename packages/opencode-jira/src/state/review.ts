import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { changeReview, reviewHTML } from "../core/review.js";
import { LocalId } from "../core/proposals.js";
import { IssueKeeperError } from "../errors.js";
import { withChangeStore } from "./coordinator.js";
import { StateError } from "./errors.js";

export interface ReviewIO { print: (text: string) => void; readHash: () => Promise<string> }
export async function reviewProposal(proposalId: string, io: ReviewIO, options: { data?: string } = {}): Promise<void> {
  if (!LocalId.safeParse(proposalId).success) throw new IssueKeeperError("VALIDATION_FAILED", "Identificador de propuesta inválido.");
  await withChangeStore(async (store) => {
    const saved = store.get(proposalId);
    if (saved.execution.state !== "prepared") throw new StateError("CONFLICT");
    if (Date.now() >= Date.parse(saved.plan.expiresAt)) throw new StateError("EXPIRED");
    const review = changeReview(saved.plan);
    const html = reviewHTML(review);
    const reservation = store.reserveStaging(Buffer.byteLength(html));
    const path = join(store.paths.staging, `review-${randomUUID()}.html`);
    let file;
    try {
      file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await file.writeFile(html, "utf8"); await file.sync();
      io.print(`Abra la vista privada completa en su navegador:\n${pathToFileURL(path).href}\nRevise destino, audiencia, contenido, personas y archivos. Al terminar, copie el SHA-256 de la vista que figura al final. No es un permiso de envío.`);
      const answer = (await io.readHash()).trim();
      if (answer !== review.reviewHash) throw new IssueKeeperError("FORBIDDEN", "Revisión no confirmada; no se ha autorizado ni enviado ningún cambio.");
      store.acknowledgeReview(proposalId, saved.execution.revision, review.reviewHash);
      io.print(`Revisión registrada para ${proposalId}, plan ${review.payloadHash}. Aún requiere jira.write al aplicar.`);
    } finally {
      try {
        if (file) {
          try {
            const own = await file.stat(); const current = await lstat(path).catch(() => undefined);
            if (current?.isFile() && current.ino === own.ino && current.dev === own.dev && current.nlink === 1) await unlink(path);
          } finally { await file.close(); }
        }
      } finally { reservation.release(); }
    }
  }, options);
}
