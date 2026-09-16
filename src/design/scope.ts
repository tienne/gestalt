/**
 * 무엇을 검사 대상으로 볼지 정한다.
 *
 * 실제 레포에 탐지기를 그냥 돌리면 7천 건이 나온다. 그만큼 나오면 사람이 리포트를
 * 통째로 무시한다. 무시되는 검사는 없는 검사와 같다. 잡을 수 있는 걸 다 잡는 게 아니라
 * **고칠 수 있는 것만** 잡아야 한다.
 *
 * 가르는 기준은 "디자인 시스템 안에 있느냐"다. 시스템을 쓰면서 타입 바깥으로 샌 값은
 * 바로 고칠 수 있다. 시스템을 아예 안 쓰는 파일에서 나온 값은 고치려면 그 화면을 다시
 * 만들어야 하므로 같은 리포트에 섞으면 안 된다.
 */

export type Zone =
  /** 디자인 시스템을 쓰는 파일. 여기서 샌 값은 고칠 수 있다 */
  | 'inside'
  /** 디자인 시스템을 안 쓰는 파일. 미채택이지 누수가 아니다 */
  | 'outside'
  /** 검사 대상이 아닌 파일 */
  | 'excluded';

/**
 * 제품 화면이 아닌 자리.
 *
 * 스토리북과 테스트는 예제라 일부러 하드코딩한다. 빌드나 런타임 인프라는 디자인 시스템을
 * 쓸 이유가 없다. 이런 걸 세면 고칠 수 없는 항목이 리포트를 채운다.
 */
const EXCLUDED_PATH =
  /(^|\/)(\.storybook|__tests__|__mocks__|node_modules|dist|build|coverage|e2e|playwright)(\/|$)/;

const EXCLUDED_FILE = /\.(test|spec|stories|e2e|figma\.stories|d)\.(tsx?|jsx?)$/;

/** 디자인 시스템을 쓰는지 판별할 import 표기 */
const DS_IMPORT = /from\s+['"]@catchtable\/plate/;

export interface ZoneOptions {
  /**
   * 디자인 시스템 import를 알아보는 정규식. 조직마다 패키지 이름이 다르므로 주입받는다.
   * 게슈탈트가 특정 조직 이름을 갖고 있으면 다른 레포에서 못 쓴다.
   */
  dsImport?: RegExp;
  /** 추가로 제외할 경로 */
  excludePaths?: RegExp;
}

export function zoneOf(filePath: string, source: string, options: ZoneOptions = {}): Zone {
  const excluded = options.excludePaths;
  if (EXCLUDED_PATH.test(filePath) || EXCLUDED_FILE.test(filePath)) return 'excluded';
  if (excluded?.test(filePath)) return 'excluded';

  // 스타일시트는 import 문이 없어 자기만으로는 안팎을 못 가린다. 같은 디렉토리의
  // 컴포넌트가 시스템을 쓰는지 봐야 하는데 파일 하나만 보는 이 함수로는 알 수 없다.
  // 섞어서 세는 것보다 바깥으로 두고 미채택 지표에만 넣는 편이 정직하다
  if (/\.(css|scss|sass|less)$/.test(filePath)) return 'outside';

  return (options.dsImport ?? DS_IMPORT).test(source) ? 'inside' : 'outside';
}
