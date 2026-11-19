import { createHash } from 'node:crypto';
import {
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../core/json-file.js';
import { SLIDE_STATUS_FILE } from '../digest/slides.js';
import { DigestStore } from '../digest/store.js';
import { ingestLens, type LensIngestOptions } from './ingest.js';

type SlideIngestResult =
  | { status: 'ok'; source: string; transcriptPath: string; sourcePath: string; warnings: string[] }
  | { status: 'failed'; error: string };

/** 영상 폴더 안에 PDF 스냅샷을 둔다. 다시 수집해도 이미 저장한 출처가 다른 PDF를 열면 안 된다 */
export async function ingestDigestSlides(
  input: string,
  slug: string,
  opts: LensIngestOptions,
): Promise<SlideIngestResult> {
  const store = new DigestStore(opts.repoRoot);
  const dir = store.dir(slug);
  const statusPath = join(dir, SLIDE_STATUS_FILE);
  let staging: string | undefined;
  try {
    mkdirSync(dir, { recursive: true });
    staging = mkdtempSync(join(store.root, '.slides-'));
    const pdf = await ingestLens(input, { ...opts, repoRoot: staging, kind: 'pdf', slug: 'deck' });
    const extracted = new DigestStore(staging).dir(pdf.slug);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(join(extracted, 'cache', 'source.pdf'))) {
      hash.update(chunk);
    }
    hash.update(readFileSync(pdf.transcriptPath)).update(readFileSync(pdf.sourcePath));
    const source = `slides-${hash.digest('hex').slice(0, 24)}`;
    const destination = join(dir, source);
    try {
      renameSync(extracted, destination);
    } catch (e) {
      // 같은 스냅샷을 다른 수집이 먼저 저장했으면 그 경로를 함께 쓴다
      if (!['EEXIST', 'ENOTEMPTY'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
    }
    writeJsonAtomic(statusPath, source);
    return {
      status: 'ok',
      source,
      transcriptPath: join(destination, 'transcript.json'),
      sourcePath: join(destination, 'source.json'),
      warnings: pdf.warnings,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    try {
      writeJsonAtomic(statusPath, 'failed');
    } catch (statusError) {
      return {
        status: 'failed',
        error: `${error}\n수집 상태를 저장하지 못했어요: ${String(statusError)}`,
      };
    }
    return { status: 'failed', error };
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
}
