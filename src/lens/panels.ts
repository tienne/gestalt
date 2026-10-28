import { writeJsonAtomic } from '../core/json-file.js';
import { lensSourcePath, readLensSource } from '../digest/lens-source.js';
import { DigestStore } from '../digest/store.js';

/**
 * 원문 그림의 장면 수를 source.json에 적는다. C 재구성의 칸 수 상한이 이 값이다.
 * 장면 수는 크롭을 본 세션이 정한다. 추출기는 비트맵 한 장에 여러 장면이 든 그림을 못 센다
 */
export function setFigurePanels(
  repoRoot: string,
  slug: string,
  figureId: string,
  panels: number,
): { path: string; figure: string; panels: number } {
  if (!Number.isInteger(panels) || panels < 1 || panels > 12) {
    throw new Error(`장면 수는 1~12 정수여야 해요: ${panels}`);
  }
  const store = new DigestStore(repoRoot);
  const source = readLensSource(store, slug);
  if (!source)
    throw new Error(
      `source.json이 없거나 깨졌어요. gestalt lens ingest를 다시 돌려 주세요: ${slug}`,
    );
  const fig = source.figures.find((f) => f.id === figureId);
  if (!fig) {
    throw new Error(
      `그림 ${figureId}가 없어요. 있는 그림: ${source.figures.map((f) => f.id).join(', ') || '없음'}`,
    );
  }
  fig.panels = panels;
  const path = lensSourcePath(store, slug);
  writeJsonAtomic(path, source);
  return { path, figure: figureId, panels };
}
