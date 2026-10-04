import { ALL_PACKS_VOCABULARY } from './packs/index.js';
import type { DisplayKind, NodeKind } from './types.js';

// 색과 아이콘은 팩의 nodeKinds와 displayKinds에 있다
const KIND_COLORS = Object.fromEntries(
  Object.entries(ALL_PACKS_VOCABULARY.looks).map(([k, d]) => [k, d.color]),
) as Record<DisplayKind, { light: string; dark: string }>;

// 24 격자 선 아이콘. 이모지는 플랫폼마다 모양이 달라서 path로 직접 그린다
const KIND_ICONS = Object.fromEntries(
  Object.entries(ALL_PACKS_VOCABULARY.looks).map(([k, d]) => [k, d.icon]),
) as Record<DisplayKind, string>;

// 플랫폼 칩 아이콘. 앱 둘은 칩만 보고 바로 알아보게 공식 로고를 브랜드 색으로 채워 그린다. 모양은 simple-icons에서 가져왔다
const PLATFORM_ICONS: Record<string, string> = {
  web: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 9h18"/>',
  android: `<path fill="currentColor" stroke="none" d="M18.4395 5.5586c-.675 1.1664-1.352 2.3318-2.0274 3.498-.0366-.0155-.0742-.0286-.1113-.043-1.8249-.6957-3.484-.8-4.42-.787-1.8551.0185-3.3544.4643-4.2597.8203-.084-.1494-1.7526-3.021-2.0215-3.4864a1.1451 1.1451 0 0 0-.1406-.1914c-.3312-.364-.9054-.4859-1.379-.203-.475.282-.7136.9361-.3886 1.5019 1.9466 3.3696-.0966-.2158 1.9473 3.3593.0172.031-.4946.2642-1.3926 1.0177C2.8987 12.176.452 14.772 0 18.9902h24c-.119-1.1108-.3686-2.099-.7461-3.0683-.7438-1.9118-1.8435-3.2928-2.7402-4.1836a12.1048 12.1048 0 0 0-2.1309-1.6875c.6594-1.122 1.312-2.2559 1.9649-3.3848.2077-.3615.1886-.7956-.0079-1.1191a1.1001 1.1001 0 0 0-.8515-.5332c-.5225-.0536-.9392.3128-1.0488.5449zm-.0391 8.461c.3944.5926.324 1.3306-.1563 1.6503-.4799.3197-1.188.0985-1.582-.4941-.3944-.5927-.324-1.3307.1563-1.6504.4727-.315 1.1812-.1086 1.582.4941zM7.207 13.5273c.4803.3197.5506 1.0577.1563 1.6504-.394.5926-1.1038.8138-1.584.4941-.48-.3197-.5503-1.0577-.1563-1.6504.4008-.6021 1.1087-.8106 1.584-.4941z"/>`,
  ios: `<path fill="currentColor" stroke="none" d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/>`,
};

// 데이터 저장소 엔진 로고. 카드만 보고 어떤 DB인지 알아보게 브랜드 모양을 채워 그린다. 모양은 simple-icons에서 가져왔다
const ENGINE_ICONS: Record<
  | 'documentdb'
  | 'dynamodb'
  | 'elasticsearch'
  | 'mariadb'
  | 'mongodb'
  | 'mysql'
  | 'postgresql'
  | 'redis',
  { body: string; viewBox?: string }
> = {
  documentdb: {
    body: '<path d="m16.5053 21.0947.7158.4632C16.2526 23.0316 13.0947 24 9.3895 24c-4.6316 0-8.1263-1.4737-8.1263-3.4105V3.3685C1.2632 1.7262 4.1263 0 9.4737 0c5.3474 0 8.2105 1.7263 8.2105 3.3684v2.9053h-.8421V4.8842c-1.221 1.0105-3.7053 1.8105-7.3684 1.8105-3.6632 0-6.1474-.8-7.3684-1.8105v4.8c.3368 1.179 3.2 2.3579 7.242 2.3579q1.0948 0 2.1053-.1263l.1263.842q-1.0947.1264-2.2315.1264c-3.2421 0-5.9369-.7158-7.2421-1.8105v4.5052c.3368 1.1369 3.2 2.3158 7.242 2.3158q1.0527 0 2.1053-.0842l.1263.8q-1.1368.1263-2.2315.1263c-3.2421 0-5.9369-.7157-7.2421-1.8105v3.6632c0 1.221 2.9894 2.5684 7.2842 2.5684 3.7894 0 6.442-1.0526 7.1158-2.0632zm-14.4-17.7263c0 1.179 3.0315 2.4842 7.3684 2.4842 4.3368 0 7.3684-1.3052 7.3684-2.4842 0-1.221-3.0316-2.5263-7.3684-2.5263-4.3369 0-7.3684 1.3053-7.3684 2.5263zm20.6315 7.6632v9.0947c0 .2526-.1684.421-.421.421h-8c-.2526 0-.421-.1684-.421-.421V9.2211c0-.2106.1684-.4211.421-.4211h4.6316l-.7158-.8421h-5.179V18.021h.421v.842h-.842c-.2527 0-.421-.1684-.421-.421V7.5368c0-.2105.1683-.421.421-.421h5.8105c.1263 0 .2526.0842.2947.1684L20.0421 8.8h.4632q.1684 0 .2947.1263l1.8105 1.8105q.1263.1264.1263.2948zm-.842.7158h-2.1053c-.2527 0-.421-.1685-.421-.421V9.642h-4.6317v10.0632h7.158zm-2.4422.9684c.2527 0 .4632.0842.5895.2526.2526.3369.2105.8.2105.9684 0 .8843.5053 1.0527.5474 1.0948.1684.042.2947.2105.2947.421 0 .1685-.1263.3369-.2947.379-.0421 0-.5474.2105-.5474 1.0947 0 .5053-.2526 1.0526-.8 1.0526h-.2947v-.842h.2105c0-.0422.0421-.1264.0421-.2106 0-.7579.2527-1.221.5053-1.5158-.2526-.2526-.5053-.7579-.5053-1.5158v-.3368h-.2526v-.8421zm.758-1.8105h1.3473L20.2947 9.642h-.0842zm-2.737 1.8105h.337v.842h-.2527v.2106c0 .758-.2526 1.221-.5474 1.5158.2948.2947.5474.7579.5474 1.5158q0 .0421-.0421.0842v.2947h.2947v.8422h-.3368c-.2105 0-.421-.1264-.5895-.2948-.2526-.2947-.2105-.8-.1684-.9684-.0421-.8842-.5053-1.0526-.5895-1.0526-.1684-.0421-.2947-.2527-.2947-.421 0-.1685.1263-.337.3368-.379.0421-.0421.5474-.2106.5474-1.1369-.0421-.4631.2105-1.0526.7579-1.0526z"/>',
  },
  dynamodb: {
    body: '<path d="M16.606 20.705v-2.371c-1.263 1.082-3.884 1.795-7.066 1.795-3.184 0-5.805-.714-7.068-1.797v2.369c0 1.168 2.903 2.47 7.068 2.47 4.16 0 7.06-1.3 7.066-2.466zm.001-6.765l.817-.005v.005c0 .517-.258.998-.75 1.441.601.54.75 1.071.75 1.449a1661.7 1661.7 0 0 0 0 3.87c0 1.881-3.389 3.3-7.884 3.3-4.471 0-7.846-1.404-7.88-3.27a583.119 583.119 0 0 1-.003-3.909c.001-.375.15-.9.745-1.437-.592-.538-.743-1.062-.746-1.435v-3.892c.002-.377.153-.903.747-1.438-.593-.54-.744-1.062-.747-1.435 0-1.357-.002-2.735.002-3.897C1.674 1.412 5.056 0 9.54 0c2.159 0 4.233.356 5.689.974l-.315.766c-1.36-.58-3.319-.91-5.374-.91-4.165 0-7.067 1.3-7.067 2.47 0 1.168 2.902 2.47 7.067 2.47.115 0 .222 0 .334-.005l.033.828c-.122.006-.245.006-.367.006-3.184 0-5.805-.714-7.068-1.798v2.38c.005.45.45.843.821 1.093 1.116.736 3.114 1.239 5.34 1.342l-.037.829c-2.254-.105-4.23-.59-5.5-1.332-.318.245-.623.573-.623.952 0 1.168 2.902 2.47 7.067 2.47.411 0 .812-.014 1.203-.042l.06.826c-.41.03-.833.045-1.263.045-3.184 0-5.805-.713-7.068-1.797v2.368c.005.462.449.855.821 1.104 1.275.842 3.67 1.366 6.247 1.366h.182v.83H9.54c-2.62 0-4.99-.507-6.444-1.359-.317.245-.623.574-.623.954 0 1.168 2.902 2.47 7.067 2.47 4.159 0 7.058-1.298 7.066-2.465v-.007c0-.377-.303-.705-.62-.948a5.732 5.732 0 0 1-.662.336l-.316-.764c.3-.128.56-.266.776-.412.376-.254.823-.651.823-1.1zm4.377-6.915h-2.717a.406.406 0 0 1-.332-.173.42.42 0 0 1-.055-.375l1.204-3.597h-5.403l-2.583 4.974h2.623c.128 0 .248.06.325.164a.418.418 0 0 1 .069.36l-2.249 8.365zm1.249-.128l-10.89 11.608a.408.408 0 0 1-.498.075.418.418 0 0 1-.192-.471l2.534-9.426h-2.766a.407.407 0 0 1-.349-.2.418.418 0 0 1-.012-.407l3.014-5.804a.408.408 0 0 1 .36-.222h6.22c.132 0 .256.065.332.174a.422.422 0 0 1 .055.374l-1.204 3.598h3.1c.164 0 .31.099.375.251a.422.422 0 0 1-.08.45zM3.085 20.723a8.107 8.107 0 0 0 1.72.72l.233-.794a7.32 7.32 0 0 1-1.546-.645zm1.72-5.984l.233-.795a7.262 7.262 0 0 1-1.546-.646l-.407.72a8.051 8.051 0 0 0 1.72.72zm-1.72-7.427l.407-.719c.418.244.939.462 1.546.646l-.232.794a8.046 8.046 0 0 1-1.72-.72Z"/>',
  },
  elasticsearch: {
    body: '<path d="M13.394 0C8.683 0 4.609 2.716 2.644 6.667h15.641a4.77 4.77 0 0 0 3.073-1.11c.446-.375.864-.785 1.247-1.243l.001-.002A11.974 11.974 0 0 0 13.394 0zM1.804 8.889a12.009 12.009 0 0 0 0 6.222h14.7a3.111 3.111 0 1 0 0-6.222zm.84 8.444C4.61 21.283 8.684 24 13.395 24c3.701 0 7.011-1.677 9.212-4.312l-.001-.002a9.958 9.958 0 0 0-1.247-1.243 4.77 4.77 0 0 0-3.073-1.11z"/>',
  },
  mariadb: {
    body: '<path d="M23.157 4.412c-.676.284-.79.31-1.673.372-.65.045-.757.057-1.212.209-.75.246-1.395.75-2.02 1.59-.296.398-1.249 1.913-1.249 1.988 0 .057-.65.998-.915 1.32-.574.713-1.08 1.079-2.14 1.59-.77.36-1.224.524-4.102 1.477-1.073.353-2.133.738-2.367.864-.852.449-1.515 1.036-2.203 1.938-1.003 1.32-.972 1.313-3.042.947a12.264 12.264 0 00-.675-.063c-.644-.05-1.023.044-1.332.334L0 17.193l.177.088c.094.05.353.234.561.398.215.17.461.347.55.391.088.044.17.088.183.101.012.013-.089.17-.228.353-.435.581-.593.871-.574 1.048.019.164.032.17.43.17.517-.006.826-.056 1.261-.208.65-.233 2.058-.94 2.784-1.4.776-.5 1.717-.998 1.956-1.042.082-.02.354-.07.594-.114.58-.107 1.464-.095 2.587.05.108.013.373.045.6.064.227.025.43.057.454.076.026.012.474.037.998.056.934.026 1.104.007 1.3-.189.126-.133.385-.631.498-.985.209-.643.417-.921.366-.492-.113.966-.322 1.692-.713 2.411-.259.499-.663 1.092-.934 1.395-.322.347-.315.36.088.315.619-.063 1.471-.397 2.096-.82.827-.562 1.647-1.691 2.19-3.03.107-.27.22-.22.183.083-.013.094-.038.315-.057.498l-.031.328.353-.202c.833-.48 1.414-1.262 2.127-2.884.227-.518.877-2.922 1.073-3.976a9.64 9.64 0 01.271-1.042c.127-.429.196-.555.48-.858.183-.19.625-.555.978-.808.72-.505.953-.75 1.187-1.205.208-.417.284-1.13.132-1.357-.132-.202-.284-.196-.763.006Z"/>',
  },
  mongodb: {
    body: '<path d="M17.193 9.555c-1.264-5.58-4.252-7.414-4.573-8.115-.28-.394-.53-.954-.735-1.44-.036.495-.055.685-.523 1.184-.723.566-4.438 3.682-4.74 10.02-.282 5.912 4.27 9.435 4.888 9.884l.07.05A73.49 73.49 0 0111.91 24h.481c.114-1.032.284-2.056.51-3.07.417-.296.604-.463.85-.693a11.342 11.342 0 003.639-8.464c.01-.814-.103-1.662-.197-2.218zm-5.336 8.195s0-8.291.275-8.29c.213 0 .49 10.695.49 10.695-.381-.045-.765-1.76-.765-2.405z"/>',
  },
  // 원래 로고는 돌고래 아래에 MySQL 글자가 붙어 있어 12px에선 글자가 뭉개진다. 돌고래만 남기고 그 둘레로 viewBox를 좁혔다
  mysql: {
    viewBox: '14.17 3.76 9.83 9.83',
    body: '<path stroke="currentColor" stroke-width=".25" d="M16.405 5.501c-.115 0 -.193 .014 -.274 .033v.013h.014c.054 .104 .146 .18 .214 .273c.054 .107 .1 .214 .154 .32l.014 -.015c.094 -.066 .14 -.172 .14 -.333c-.04 -.047 -.046 -.094 -.08 -.14c-.04 -.067 -.126 -.1 -.18 -.153zM23.224 11.311c-.535 -.014 -.95 .04 -1.297 .188c-.1 .04 -.26 .04 -.274 .167c.055 .053 .063 .14 .11 .214c.08 .134 .218 .313 .346 .407c.14 .11 .28 .216 .427 .31c.26 .16 .555 .255 .81 .416c.145 .094 .293 .213 .44 .313c.073 .05 .12 .14 .214 .172v-.02c-.046 -.06 -.06 -.147 -.105 -.214c-.067 -.067 -.134 -.127 -.2 -.193a3.223 3.223 0 0 0 -.695 -.675c-.214 -.146 -.682 -.35 -.77 -.595l-.013 -.014c.146 -.013 .32 -.066 .46 -.106c.227 -.06 .435 -.047 .67 -.106c.106 -.027 .213 -.06 .32 -.094v-.06c-.12 -.12 -.21 -.283 -.334 -.395a8.867 8.867 0 0 0 -1.104 -.823c-.21 -.134 -.476 -.22 -.697 -.334c-.08 -.04 -.214 -.06 -.26 -.127c-.12 -.146 -.19 -.34 -.275 -.514a17.69 17.69 0 0 1 -.547 -1.163c-.12 -.262 -.193 -.523 -.34 -.763c-.69 -1.137 -1.437 -1.826 -2.586 -2.5c-.247 -.14 -.543 -.2 -.856 -.274c-.167 -.008 -.334 -.02 -.5 -.027c-.11 -.047 -.216 -.174 -.31 -.235c-.38 -.24 -1.364 -.76 -1.644 -.072c-.18 .434 .267 .862 .422 1.082c.115 .153 .26 .328 .34 .5c.047 .116 .06 .235 .107 .356c.106 .294 .207 .622 .347 .897c.073 .14 .153 .287 .247 .413c.054 .073 .146 .107 .167 .227c-.094 .136 -.1 .334 -.154 .5c-.24 .757 -.146 1.693 .194 2.25c.107 .166 .362 .534 .703 .393c.3 -.12 .234 -.5 .32 -.835c.02 -.08 .007 -.133 .048 -.187v.015c.094 .188 .188 .367 .274 .555c.206 .328 .566 .668 .867 .895c.16 .12 .287 .328 .487 .402v-.02h-.015c-.043 -.058 -.1 -.086 -.154 -.133a3.445 3.445 0 0 1 -.35 -.4a8.76 8.76 0 0 1 -.747 -1.218c-.11 -.21 -.202 -.436 -.29 -.643c-.04 -.08 -.04 -.2 -.107 -.24c-.1 .146 -.247 .273 -.32 .453c-.127 .288 -.14 .642 -.188 1.01c-.027 .007 -.014 0 -.027 .014c-.214 -.052 -.287 -.274 -.367 -.46c-.2 -.475 -.233 -1.238 -.06 -1.785c.047 -.14 .247 -.582 .167 -.716c-.042 -.127 -.174 -.2 -.247 -.303a2.478 2.478 0 0 1 -.24 -.427c-.16 -.374 -.24 -.788 -.414 -1.162c-.08 -.173 -.22 -.354 -.334 -.513c-.127 -.18 -.267 -.307 -.368 -.52c-.033 -.073 -.08 -.194 -.027 -.274c.014 -.054 .042 -.075 .094 -.09c.088 -.072 .335 .022 .422 .062c.247 .1 .455 .194 .662 .334c.094 .066 .195 .193 .315 .226h.14c.214 .047 .455 .014 .655 .073c.355 .114 .675 .28 .962 .46a5.953 5.953 0 0 1 2.085 2.286c.08 .154 .115 .295 .188 .455c.14 .33 .313 .663 .455 .982c.14 .315 .275 .636 .476 .897c.1 .14 .502 .213 .682 .286c.133 .06 .34 .115 .46 .188c.23 .14 .454 .3 .67 .454c.11 .076 .443 .243 .463 .378z"/>',
  },
  postgresql: {
    body: '<path d="M23.5594 14.7228a.5269.5269 0 0 0-.0563-.1191c-.139-.2632-.4768-.3418-1.0074-.2321-1.6533.3411-2.2935.1312-2.5256-.0191 1.342-2.0482 2.445-4.522 3.0411-6.8297.2714-1.0507.7982-3.5237.1222-4.7316a1.5641 1.5641 0 0 0-.1509-.235C21.6931.9086 19.8007.0248 17.5099.0005c-1.4947-.0158-2.7705.3461-3.1161.4794a9.449 9.449 0 0 0-.5159-.0816 8.044 8.044 0 0 0-1.3114-.1278c-1.1822-.0184-2.2038.2642-3.0498.8406-.8573-.3211-4.7888-1.645-7.2219.0788C.9359 2.1526.3086 3.8733.4302 6.3043c.0409.818.5069 3.334 1.2423 5.7436.4598 1.5065.9387 2.7019 1.4334 3.582.553.9942 1.1259 1.5933 1.7143 1.7895.4474.1491 1.1327.1441 1.8581-.7279.8012-.9635 1.5903-1.8258 1.9446-2.2069.4351.2355.9064.3625 1.39.3772a.0569.0569 0 0 0 .0004.0041 11.0312 11.0312 0 0 0-.2472.3054c-.3389.4302-.4094.5197-1.5002.7443-.3102.064-1.1344.2339-1.1464.8115-.0025.1224.0329.2309.0919.3268.2269.4231.9216.6097 1.015.6331 1.3345.3335 2.5044.092 3.3714-.6787-.017 2.231.0775 4.4174.3454 5.0874.2212.5529.7618 1.9045 2.4692 1.9043.2505 0 .5263-.0291.8296-.0941 1.7819-.3821 2.5557-1.1696 2.855-2.9059.1503-.8707.4016-2.8753.5388-4.1012.0169-.0703.0357-.1207.057-.1362.0007-.0005.0697-.0471.4272.0307a.3673.3673 0 0 0 .0443.0068l.2539.0223.0149.001c.8468.0384 1.9114-.1426 2.5312-.4308.6438-.2988 1.8057-1.0323 1.5951-1.6698zM2.371 11.8765c-.7435-2.4358-1.1779-4.8851-1.2123-5.5719-.1086-2.1714.4171-3.6829 1.5623-4.4927 1.8367-1.2986 4.8398-.5408 6.108-.13-.0032.0032-.0066.0061-.0098.0094-2.0238 2.044-1.9758 5.536-1.9708 5.7495-.0002.0823.0066.1989.0162.3593.0348.5873.0996 1.6804-.0735 2.9184-.1609 1.1504.1937 2.2764.9728 3.0892.0806.0841.1648.1631.2518.2374-.3468.3714-1.1004 1.1926-1.9025 2.1576-.5677.6825-.9597.5517-1.0886.5087-.3919-.1307-.813-.5871-1.2381-1.3223-.4796-.839-.9635-2.0317-1.4155-3.5126zm6.0072 5.0871c-.1711-.0428-.3271-.1132-.4322-.1772.0889-.0394.2374-.0902.4833-.1409 1.2833-.2641 1.4815-.4506 1.9143-1.0002.0992-.126.2116-.2687.3673-.4426a.3549.3549 0 0 0 .0737-.1298c.1708-.1513.2724-.1099.4369-.0417.156.0646.3078.26.3695.4752.0291.1016.0619.2945-.0452.4444-.9043 1.2658-2.2216 1.2494-3.1676 1.0128zm2.094-3.988-.0525.141c-.133.3566-.2567.6881-.3334 1.003-.6674-.0021-1.3168-.2872-1.8105-.8024-.6279-.6551-.9131-1.5664-.7825-2.5004.1828-1.3079.1153-2.4468.079-3.0586-.005-.0857-.0095-.1607-.0122-.2199.2957-.2621 1.6659-.9962 2.6429-.7724.4459.1022.7176.4057.8305.928.5846 2.7038.0774 3.8307-.3302 4.7363-.084.1866-.1633.3629-.2311.5454zm7.3637 4.5725c-.0169.1768-.0358.376-.0618.5959l-.146.4383a.3547.3547 0 0 0-.0182.1077c-.0059.4747-.054.6489-.115.8693-.0634.2292-.1353.4891-.1794 1.0575-.11 1.4143-.8782 2.2267-2.4172 2.5565-1.5155.3251-1.7843-.4968-2.0212-1.2217a6.5824 6.5824 0 0 0-.0769-.2266c-.2154-.5858-.1911-1.4119-.1574-2.5551.0165-.5612-.0249-1.9013-.3302-2.6462.0044-.2932.0106-.5909.019-.8918a.3529.3529 0 0 0-.0153-.1126 1.4927 1.4927 0 0 0-.0439-.208c-.1226-.4283-.4213-.7866-.7797-.9351-.1424-.059-.4038-.1672-.7178-.0869.067-.276.1831-.5875.309-.9249l.0529-.142c.0595-.16.134-.3257.213-.5012.4265-.9476 1.0106-2.2453.3766-5.1772-.2374-1.0981-1.0304-1.6343-2.2324-1.5098-.7207.0746-1.3799.3654-1.7088.5321a5.6716 5.6716 0 0 0-.1958.1041c.0918-1.1064.4386-3.1741 1.7357-4.4823a4.0306 4.0306 0 0 1 .3033-.276.3532.3532 0 0 0 .1447-.0644c.7524-.5706 1.6945-.8506 2.802-.8325.4091.0067.8017.0339 1.1742.081 1.939.3544 3.2439 1.4468 4.0359 2.3827.8143.9623 1.2552 1.9315 1.4312 2.4543-1.3232-.1346-2.2234.1268-2.6797.779-.9926 1.4189.543 4.1729 1.2811 5.4964.1353.2426.2522.4522.2889.5413.2403.5825.5515.9713.7787 1.2552.0696.087.1372.1714.1885.245-.4008.1155-1.1208.3825-1.0552 1.717-.0123.1563-.0423.4469-.0834.8148-.0461.2077-.0702.4603-.0994.7662zm.8905-1.6211c-.0405-.8316.2691-.9185.5967-1.0105a2.8566 2.8566 0 0 0 .135-.0406 1.202 1.202 0 0 0 .1342.103c.5703.3765 1.5823.4213 3.0068.1344-.2016.1769-.5189.3994-.9533.6011-.4098.1903-1.0957.333-1.7473.3636-.7197.0336-1.0859-.0807-1.1721-.151zm.5695-9.2712c-.0059.3508-.0542.6692-.1054 1.0017-.055.3576-.112.7274-.1264 1.1762-.0142.4368.0404.8909.0932 1.3301.1066.887.216 1.8003-.2075 2.7014a3.5272 3.5272 0 0 1-.1876-.3856c-.0527-.1276-.1669-.3326-.3251-.6162-.6156-1.1041-2.0574-3.6896-1.3193-4.7446.3795-.5427 1.3408-.5661 2.1781-.463zm.2284 7.0137a12.3762 12.3762 0 0 0-.0853-.1074l-.0355-.0444c.7262-1.1995.5842-2.3862.4578-3.4385-.0519-.4318-.1009-.8396-.0885-1.2226.0129-.4061.0666-.7543.1185-1.0911.0639-.415.1288-.8443.1109-1.3505.0134-.0531.0188-.1158.0118-.1902-.0457-.4855-.5999-1.938-1.7294-3.253-.6076-.7073-1.4896-1.4972-2.6889-2.0395.5251-.1066 1.2328-.2035 2.0244-.1859 2.0515.0456 3.6746.8135 4.8242 2.2824a.908.908 0 0 1 .0667.1002c.7231 1.3556-.2762 6.2751-2.9867 10.5405zm-8.8166-6.1162c-.025.1794-.3089.4225-.6211.4225a.5821.5821 0 0 1-.0809-.0056c-.1873-.026-.3765-.144-.5059-.3156-.0458-.0605-.1203-.178-.1055-.2844.0055-.0401.0261-.0985.0925-.1488.1182-.0894.3518-.1226.6096-.0867.3163.0441.6426.1938.6113.4186zm7.9305-.4114c.0111.0792-.049.201-.1531.3102-.0683.0717-.212.1961-.4079.2232a.5456.5456 0 0 1-.075.0052c-.2935 0-.5414-.2344-.5607-.3717-.024-.1765.2641-.3106.5611-.352.297-.0414.6111.0088.6356.1851z"/>',
  },
  redis: {
    body: '<path d="M22.71 13.145c-1.66 2.092-3.452 4.483-7.038 4.483-3.203 0-4.397-2.825-4.48-5.12.701 1.484 2.073 2.685 4.214 2.63 4.117-.133 6.94-3.852 6.94-7.239 0-4.05-3.022-6.972-8.268-6.972-3.752 0-8.4 1.428-11.455 3.685C2.59 6.937 3.885 9.958 4.35 9.626c2.648-1.904 4.748-3.13 6.784-3.744C8.12 9.244.886 17.05 0 18.425c.1 1.261 1.66 4.648 2.424 4.648.232 0 .431-.133.664-.365a100.49 100.49 0 0 0 5.54-6.765c.222 3.104 1.748 6.898 6.014 6.898 3.819 0 7.604-2.756 9.33-8.965.2-.764-.73-1.361-1.261-.73zm-4.349-5.013c0 1.959-1.926 2.922-3.685 2.922-.941 0-1.664-.247-2.235-.568 1.051-1.592 2.092-3.225 3.21-4.973 1.972.334 2.71 1.43 2.71 2.619z"/>',
  },
};
export type DatastoreEngine = keyof typeof ENGINE_ICONS;

// 브랜드 색. 어두운 화면에서 묻히는 짙은 색만 같은 색상을 밝혀 쓴다. 애플 로고는 브랜드 색이 검정이라 어두운 화면에선 흰색이다
const BRAND_COLORS: Record<DatastoreEngine | 'android' | 'ios', { light: string; dark: string }> = {
  android: { light: '#3ddc84', dark: '#3ddc84' },
  documentdb: { light: '#c925d1', dark: '#e06ae6' },
  dynamodb: { light: '#4053d6', dark: '#7b8af0' },
  elasticsearch: { light: '#005571', dark: '#00bfb3' },
  ios: { light: '#000000', dark: '#ffffff' },
  mariadb: { light: '#003545', dark: '#5fa8bd' },
  mongodb: { light: '#47a248', dark: '#5fbf60' },
  mysql: { light: '#4479a1', dark: '#6b9bd1' },
  postgresql: { light: '#4169e1', dark: '#7b98ee' },
  redis: { light: '#ff4438', dark: '#ff6b61' },
};

// 이름 안에 이 글자가 있으면 그 엔진이다. aurora-mysql처럼 관리형 서비스 이름이 앞에 붙어도 잡는다. mariadb가 mysql보다 먼저다
const ENGINE_MATCH: readonly [string, DatastoreEngine][] = [
  ['mariadb', 'mariadb'],
  ['mysql', 'mysql'],
  ['postgres', 'postgresql'],
  ['redis', 'redis'],
  ['elasticsearch', 'elasticsearch'],
  ['documentdb', 'documentdb'],
  ['docdb', 'documentdb'],
  ['mongo', 'mongodb'],
  ['dynamo', 'dynamodb'],
];

/** datastore 노드의 엔진. engine 필드가 없으면 label에서 찾고 모르는 엔진이면 undefined다 */
export function datastoreEngine(node: {
  kind: NodeKind;
  label: string;
  engine?: string;
}): DatastoreEngine | undefined {
  if (node.kind !== 'datastore') return undefined;
  const name = (node.engine ?? node.label).toLowerCase();
  return ENGINE_MATCH.find(([needle]) => name.includes(needle))?.[1];
}

const UI_ICONS: Record<string, string> = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  fit: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  focus:
    '<circle cx="12" cy="12" r="3"/><path d="M4 8.5V6a2 2 0 0 1 2-2h2.5M15.5 4H18a2 2 0 0 1 2 2v2.5M20 15.5V18a2 2 0 0 1-2 2h-2.5M8.5 20H6a2 2 0 0 1-2-2v-2.5"/>',
  legend: '<path d="M4 6h3M4 12h3M4 18h3M10 6h10M10 12h10M10 18h10"/>',
  question:
    '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.5a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2.2-2.4 3.6M12 17h.01"/>',
  person: '<circle cx="12" cy="8" r="3.8"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  system:
    '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6v6H9zM9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  flow: '<path d="M3.5 7h9M3.5 17h5M12.5 7l3 3-3 3M8.5 17l3-3"/><circle cx="18.5" cy="10" r="2"/>',
};

function symbol(id: string, body: string): string {
  return (
    `<symbol id="${id}" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.9" ` +
    `stroke-linecap="round" stroke-linejoin="round">${body}</g></symbol>`
  );
}

function filledSymbol(id: string, body: string, viewBox = '0 0 24 24'): string {
  return `<symbol id="${id}" viewBox="${viewBox}"><g fill="currentColor">${body}</g></symbol>`;
}

/** 페이지에 한 번만 싣는 아이콘 묶음. 카드와 단추는 use로 가져다 쓴다 */
export function renderIconSprite(): string {
  const kinds = (Object.keys(KIND_ICONS) as DisplayKind[])
    .sort()
    .map((k) => symbol(`i-${k}`, KIND_ICONS[k]));
  const ui = Object.keys(UI_ICONS)
    .sort()
    .map((k) => symbol(`u-${k}`, UI_ICONS[k]!));
  const platforms = Object.keys(PLATFORM_ICONS)
    .sort()
    .map((k) => symbol(`p-${k}`, PLATFORM_ICONS[k]!));
  const engines = (Object.keys(ENGINE_ICONS) as DatastoreEngine[])
    .sort()
    .map((k) => filledSymbol(`e-${k}`, ENGINE_ICONS[k].body, ENGINE_ICONS[k].viewBox));
  return `<svg class="sprite" aria-hidden="true" focusable="false"><defs>${[...kinds, ...ui, ...platforms, ...engines].join('')}</defs></svg>`;
}

export function iconUse(id: string, cls = ''): string {
  const c = cls ? ` class="${cls}"` : '';
  return `<svg${c} viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#${id}"/></svg>`;
}

// 제품 브릭 색. 흰 글자를 올리므로 두 테마 다 같은 진한 색을 쓴다. 제품이 이보다 많으면 처음 색부터 다시 돈다
const PRODUCT_PALETTE = [
  '#0f766e',
  '#c2410c',
  '#be185d',
  '#0369a1',
  '#4d7c0f',
  '#92400e',
  '#6d28d9',
  '#475569',
] as const;
export const PRODUCT_COLORS = PRODUCT_PALETTE.length;

function productRules(): string {
  return PRODUCT_PALETTE.map((c, i) => `.p-${i}{--p:${c};}`).join('');
}

function kindRules(theme: 'light' | 'dark'): string {
  return (Object.keys(KIND_COLORS) as DisplayKind[])
    .sort()
    .map((k) => `.k-${k}{--kind:${KIND_COLORS[k][theme]};}`)
    .join('');
}

// 종류 칩의 로고는 흰 바탕 위에 서서 어두운 화면에서도 밝은 화면 색을 그대로 쓴다
function brandRules(theme: 'light' | 'dark'): string {
  return Object.keys(BRAND_COLORS)
    .sort()
    .map((k) => {
      const c = BRAND_COLORS[k as keyof typeof BRAND_COLORS];
      return theme === 'light'
        ? `.b-${k}{--brand:${c.light};--brand-on-white:${c.light};}`
        : `.b-${k}{--brand:${c.dark};}`;
    })
    .join('');
}

const LIGHT_TOKENS = `
  color-scheme: light;
  --bg: #f7f8fa;
  --surface: #ffffff;
  --surface-2: #f1f3f6;
  --border: #e3e6ea;
  --border-strong: #cdd2d9;
  --text: #1b1f24;
  --muted: #6b7280;
  --accent: #2563eb;
  --accent-soft: rgba(37, 99, 235, 0.14);
  --on-accent: #ffffff;
  --edge: #7b8494;
  --edge-alpha: 0.55;
  --edge-strong: #3f4753;
  --lane: rgba(100, 116, 139, 0.085);
  --lane-line: rgba(100, 116, 139, 0.16);
  --warn: #b45309;
  --warn-soft: #fef3c7;
  --ok: #15803d;
  --ok-soft: #dcfce7;
  --live: #0369a1;
  --live-soft: #e0f2fe;
  --x-account: #c026d3;
  --frame: rgba(3, 105, 161, 0.05);
  --frame-line: #0369a1;
  --loads: #0369a1;
  --hit: #f59e0b;
  --brick-base: #ffffff;
  --brick-tint: 24%;
  --shadow: 0 1px 2px rgba(16, 24, 40, 0.05), 0 1px 3px rgba(16, 24, 40, 0.04);
  --shadow-hover: 0 6px 16px rgba(16, 24, 40, 0.1);
  --shadow-pop: 0 12px 32px rgba(16, 24, 40, 0.14), 0 2px 6px rgba(16, 24, 40, 0.06);
`;

const DARK_TOKENS = `
  color-scheme: dark;
  --bg: #0f1115;
  --surface: #171a21;
  --surface-2: #1e222b;
  --border: #2a2f3a;
  --border-strong: #3b4250;
  --text: #e6e8ec;
  --muted: #8b93a1;
  --accent: #60a5fa;
  --accent-soft: rgba(96, 165, 250, 0.2);
  --on-accent: #0b1220;
  --edge: #8d96a8;
  --edge-alpha: 0.5;
  --edge-strong: #dde1e8;
  --lane: rgba(148, 163, 184, 0.06);
  --lane-line: rgba(148, 163, 184, 0.13);
  --warn: #fbbf24;
  --warn-soft: rgba(251, 191, 36, 0.14);
  --ok: #4ade80;
  --ok-soft: rgba(74, 222, 128, 0.12);
  --live: #38bdf8;
  --live-soft: rgba(56, 189, 248, 0.14);
  --x-account: #e879f9;
  --frame: rgba(125, 211, 252, 0.06);
  --frame-line: #7dd3fc;
  --loads: #7dd3fc;
  --hit: #fbbf24;
  --brick-base: #171a21;
  --brick-tint: 44%;
  --shadow: none;
  --shadow-hover: 0 6px 18px rgba(0, 0, 0, 0.4);
  --shadow-pop: 0 16px 40px rgba(0, 0, 0, 0.55);
`;

const LAYOUT_CSS = `
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0; display: flex; flex-direction: column; height: 100vh; overflow: hidden;
  background: var(--bg); color: var(--text);
  font: 14px/1.45 var(--font); -webkit-font-smoothing: antialiased;
}
button { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sprite { position: absolute; width: 0; height: 0; overflow: hidden; }
.bar {
  flex: none; height: 48px; display: flex; align-items: center; gap: 8px; padding: 0 12px 0 16px;
  background: var(--surface); border-bottom: 1px solid var(--border); position: relative; z-index: 20;
}
.bar h1 { margin: 0; font-size: 14px; font-weight: 650; white-space: nowrap; }
.crumbs { display: flex; align-items: center; gap: 2px; min-width: 0; overflow: hidden; font-size: 13px; color: var(--muted); }
.crumbs::before { content: ''; width: 1px; height: 16px; background: var(--border); margin: 0 8px 0 4px; flex: none; }
.crumbs[hidden] { display: none; }
.crumbs button { border: 0; background: none; padding: 4px 6px; border-radius: 6px; cursor: pointer; color: var(--muted); white-space: nowrap; }
.crumbs button:hover { background: var(--surface-2); color: var(--text); }
.crumbs .sep { opacity: 0.6; padding: 0 1px; }
.crumbs .here { color: var(--text); font-weight: 600; padding: 4px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.spacer { flex: 1; }
.focus-chip {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 4px 0 10px; margin-left: 6px; flex: none; max-width: 320px;
  border-radius: 14px; font-size: 12px; color: var(--accent); background: var(--accent-soft); white-space: nowrap;
}
.focus-chip[hidden] { display: none; }
.focus-chip svg { width: 14px; height: 14px; flex: none; }
.focus-chip b { overflow: hidden; text-overflow: ellipsis; color: var(--text); font-weight: 650; }
.focus-chip button { flex: none; width: 22px; height: 22px; padding: 3px; border: 0; border-radius: 11px; background: none; color: var(--accent); cursor: pointer; }
.focus-chip button:hover { background: var(--accent-soft); }
.btn[hidden] { display: none; }
.search {
  display: flex; align-items: center; gap: 6px; height: 32px; width: 240px; padding: 0 10px;
  border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--muted);
}
.search:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.search svg { width: 15px; height: 15px; flex: none; }
.search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text); font: inherit; font-size: 13px; }
.search input::-webkit-search-cancel-button { display: none; }
.search .count { font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.btn {
  height: 32px; display: inline-flex; align-items: center; gap: 6px; padding: 0 10px; flex: none;
  border: 1px solid var(--border); border-radius: 8px; background: var(--surface); font-size: 13px; cursor: pointer; white-space: nowrap;
}
.btn:hover { background: var(--surface-2); }
.btn svg { width: 16px; height: 16px; color: var(--muted); }
.btn.icon { width: 32px; padding: 0; justify-content: center; }
.btn[aria-expanded="true"] { background: var(--surface-2); border-color: var(--border-strong); }
.btn .n {
  min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; background: var(--surface-2); color: var(--muted);
}
.btn .n.warn { background: var(--warn-soft); color: var(--warn); }
.seg { display: inline-flex; align-items: center; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); flex: none; }
.seg .btn { border: 0; height: 30px; }
.env-picker .btn { padding: 0 9px; color: var(--muted); font-variant-numeric: tabular-nums; }
.env-picker .btn[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); font-weight: 650; }
.env-off { display: none !important; }
.zoom-level { min-width: 44px; text-align: center; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
#theme-btn .sun { display: none; }
#theme-btn[data-mode="dark"] .sun { display: block; }
#theme-btn[data-mode="dark"] .moon { display: none; }
#theme-btn[data-mode="light"] .moon { display: block; }
#theme-btn[data-mode="light"] .sun { display: none; }
.meta { display: flex; gap: 10px; padding-left: 4px; font-size: 11px; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.main { position: relative; flex: 1; min-height: 0; overflow: hidden; }
.stage { position: absolute; inset: 0; overflow: hidden; cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; }
.stage.panning { cursor: grabbing; }
.viewport { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.viewport.glide { transition: transform 0.28s cubic-bezier(0.2, 0.7, 0.2, 1); }
.level { position: relative; }
.level[hidden] { display: none; }
.links { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.lane { fill: var(--lane); stroke: var(--lane-line); stroke-width: 1; }
.frame { fill: var(--frame); stroke: var(--frame-line); stroke-width: 1.25; stroke-opacity: 0.6; }
.band-line { stroke: var(--border-strong); stroke-width: 1; stroke-dasharray: 4 4; }
.band-title {
  position: absolute; height: 20px; padding: 0 6px; display: flex; align-items: center; gap: 6px; border-radius: 4px;
  font-size: 12px; font-weight: 700; color: var(--text); background: var(--bg); white-space: nowrap; pointer-events: none;
}
.band-title .sw { width: 10px; height: 10px; border-radius: 2px; background: var(--p); }
.lane-title {
  position: absolute; display: flex; align-items: center; gap: 8px; padding: 0 14px; height: 22px;
  font-size: 14px; font-weight: 700; color: var(--text); white-space: nowrap; overflow: hidden;
}
.lane-title .n {
  min-width: 20px; height: 18px; padding: 0 6px; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 600; color: var(--muted); background: var(--surface); border: 1px solid var(--border); font-variant-numeric: tabular-nums;
}
.node {
  --brick: color-mix(in srgb, var(--kind) var(--brick-tint), var(--brick-base));
  --brick-edge: color-mix(in srgb, var(--kind) 42%, var(--brick));
  --thick: 0 3px 0 var(--brick-edge);
  position: absolute; display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: 8px; row-gap: 2px; align-content: center;
  padding: 0 20px 0 10px; cursor: pointer;
  background: var(--brick); border: 1px solid var(--brick-edge); border-radius: 4px; box-shadow: var(--thick);
  transition: box-shadow 0.15s, border-color 0.15s, opacity 0.15s;
}
/* 카드 위 돌기. 하나를 그리고 box-shadow로 셋을 더 찍는다. 그림자 사본도 모서리 둥글기를 따라간다 */
.node::before {
  content: ''; position: absolute; left: 12px; top: -6px; width: 14px; height: 5px; border-radius: 3px 3px 0 0;
  background: var(--brick-edge); box-shadow: 20px 0 var(--brick-edge), 40px 0 var(--brick-edge), 60px 0 var(--brick-edge);
}
/* 같이 쓰는 카드는 돌기 자리에 제품 브릭을 꽂는다 */
.node.shared::before { display: none; }
.pbricks { position: absolute; left: 8px; right: 8px; bottom: calc(100% + 1px); display: flex; gap: 2px; }
.pb {
  flex: none; height: 17px; padding: 0 6px; border-radius: 3px 3px 0 0;
  font: 700 10.5px/17px var(--font); color: #fff; background: var(--p); white-space: nowrap;
  box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--p) 70%, #000);
}
.pb.more {
  border: 1px solid var(--border-strong); border-bottom: 0; line-height: 15px; cursor: pointer;
  color: var(--text); background: var(--surface); box-shadow: none;
}
.pb.more:hover, .pb.more[aria-expanded="true"] { color: var(--bg); background: var(--text); border-color: var(--text); }
.pb.more:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
/* +N 드롭다운. 캔버스는 확대와 스크롤 상자 안이라 그 안에 두면 잘린다. 화면 기준으로 띄운다 */
.pmenu {
  position: fixed; z-index: 40; min-width: 168px; padding: 6px;
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: 6px; box-shadow: 0 3px 0 var(--border-strong);
}
.pmenu[hidden] { display: none; }
.pmenu h3 { margin: 2px 6px 6px; font-size: 11px; font-weight: 600; color: var(--muted); }
.pmenu ul { margin: 0; padding: 0; list-style: none; }
.pmenu li { display: flex; align-items: center; gap: 8px; padding: 4px 6px; font-size: 13px; font-weight: 600; color: var(--text); }
.pmenu .pb { height: 15px; padding: 0 5px; font-size: 10px; line-height: 15px; }
.pmenu small { margin-left: auto; font-weight: 500; color: var(--muted); }
.node:hover { box-shadow: var(--thick), var(--shadow-hover); }
.node:focus { outline: none; }
.node:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.node.is-focus { border-color: var(--kind); }
.node.focus-root:not(.selected) { border-color: var(--accent); box-shadow: var(--thick), 0 0 0 3px var(--accent-soft); }
.node.selected { border-color: var(--accent); box-shadow: var(--thick), 0 0 0 4px var(--accent-soft), var(--shadow-hover); }
.node.anchor:not(.selected) { outline: 2px dashed var(--accent); outline-offset: 3px; }
.node.hit { box-shadow: var(--thick), 0 0 0 3px var(--hit); }
.node.hit.current { box-shadow: var(--thick), 0 0 0 4px var(--hit), var(--shadow-hover); }
.kc {
  grid-row: 1; display: inline-flex; align-items: center; gap: 3px; height: 18px; padding: 0 6px 0 4px; border-radius: 5px; align-self: center;
  font-size: 10.5px; font-weight: 650; line-height: 1; white-space: nowrap;
  color: color-mix(in srgb, var(--kind) 72%, var(--text)); background: color-mix(in srgb, var(--kind) 13%, transparent);
}
.kc svg { width: 12px; height: 12px; flex: none; color: var(--kind); }
.kc svg.brand, .pf svg.brand { color: var(--brand); }
/* 붉은 저장소 칩 위에서 파란 로고가 흐려져서 흰 바탕을 깐다 */
.kc svg.brand {
  width: 16px; height: 16px; padding: 2px; margin-left: -2px; border-radius: 4px;
  color: var(--brand-on-white); background: #fff;
}
.nm { grid-row: 1; grid-column: 2; display: flex; align-items: center; min-width: 0; font-size: 13px; font-weight: 600; line-height: 18px; }
.nm .t { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.tc {
  grid-row: 2; grid-column: 1 / -1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  font: 11px/16px var(--mono); color: var(--muted);
}
.guess {
  flex: none; margin-left: 6px; padding: 0 5px; border-radius: 8px; font-size: 10px; font-weight: 600; line-height: 16px;
  color: var(--warn); background: var(--warn-soft);
}
.flow-badge {
  flex: none; display: inline-flex; align-items: center; gap: 3px; margin-left: 6px; padding: 0 6px; border-radius: 8px;
  font-size: 10.5px; font-weight: 700; line-height: 16px; color: var(--on-accent);
  background: var(--accent); box-shadow: 0 2px 0 color-mix(in srgb, var(--accent) 60%, #000);
}
.flow-badge svg { width: 12px; height: 12px; flex: none; }
.flow-badge:hover { background: color-mix(in srgb, var(--accent) 85%, var(--text)); }
/* 파스텔 브릭 위에서 연한 배지는 묻힌다. 카드 안 추정 배지는 꽉 채운다 */
.node .guess { color: var(--bg); background: var(--warn); }
.go { position: absolute; right: 8px; bottom: 4px; font-size: 14px; line-height: 1; color: var(--muted); }
.pf {
  flex: none; display: inline-flex; align-items: center; gap: 3px; height: 16px; margin-left: 4px; padding: 0 4px;
  border: 1px solid color-mix(in srgb, var(--muted) 45%, transparent); border-radius: 4px;
  font-size: 10px; font-weight: 650; line-height: 1; color: var(--muted);
}
.pf svg { width: 11px; height: 11px; flex: none; }
.tc.dom { font-family: var(--font); color: var(--text); }
.l2 { grid-row: 2; grid-column: 1 / -1; display: flex; align-items: center; min-width: 0; }
.l2 .pf:first-child { margin-left: 0; }
/* 도메인 흐름. 행위자 줄은 번갈아 옅게 칠해 줄 경계를 읽히게 하고, 옆 흐름은 정상 흐름과 색으로 가른다 */
.flane { fill: var(--lane); stroke: var(--lane-line); stroke-width: 1; }
.flane.alt { fill: color-mix(in srgb, var(--lane) 55%, var(--bg)); }
.fstage {
  position: absolute; height: 26px; display: flex; align-items: center; justify-content: center; padding: 0 10px;
  border-radius: 999px; background: var(--lane); border: 1px solid var(--lane-line);
  font: 600 12px/1 var(--mono); color: var(--text); pointer-events: none; box-sizing: border-box;
}
.fstage span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.fstage.side { font-family: inherit; color: var(--muted); border-style: dashed; }
.fstage.named { font-family: inherit; }
.fstage-line { stroke: var(--lane-line); stroke-width: 1; stroke-dasharray: 4 4; }
.fstage-line.side { stroke-width: 1.5; stroke-dasharray: none; }
.flane-title {
  position: absolute; display: flex; align-items: flex-start; gap: 6px; max-width: 112px;
  font-size: 13px; font-weight: 700; line-height: 18px; color: var(--text); pointer-events: none;
}
.flane-title span { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; word-break: keep-all; }
.flane-title svg { width: 15px; height: 15px; flex: none; margin-top: 1.5px; color: var(--muted); }
.flow-step { --kind: var(--accent); padding: 0 12px 0 12px; }
.flow-step.p-side { --kind: var(--warn); }
.flow-step.doc-only { border-style: dashed; }
.flow-step .nm { grid-column: 1 / -1; white-space: normal; }
.flow-step .nm .t { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 17px; }
.flow-step .l2 { gap: 6px; }
.flow-step .st {
  min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  font: 10.5px/16px var(--mono); padding: 0 5px; border-radius: 4px; color: var(--muted); background: var(--lane);
}
.flow-step .st.named { font-family: inherit; font-weight: 600; }
.flow-step .refs, .flow-step .qb {
  flex: none; display: inline-flex; align-items: center; gap: 2px; font-size: 10.5px; font-weight: 650; color: var(--muted);
}
.flow-step .qb { color: var(--warn); }
.flow-step .end {
  flex: none; font-size: 10.5px; line-height: 16px; font-weight: 700; padding: 0 5px; border-radius: 4px;
  color: var(--surface); background: var(--text);
}
.flow-step .refs svg, .flow-step .qb svg { width: 11px; height: 11px; }
.node .l2 { overflow: hidden; }
.link.flow-t { cursor: pointer; }
.legend-lines line.side-line { stroke: var(--warn); }
.swatch-step { display: inline-block; width: 30px; height: 14px; margin-right: 8px; border: 1.5px dashed var(--border-strong); border-radius: 4px; vertical-align: middle; }
.link.flow-t.p-side .edge { stroke: var(--warn); }
.link.flow-t.p-side .tip { fill: var(--warn); }
.link.flow-t .t-label {
  font-size: 11px; font-weight: 600; text-anchor: middle; fill: var(--muted);
  paint-order: stroke; stroke: var(--bg); stroke-width: 4px; stroke-linejoin: round;
}
.link.flow-t .t-who { fill: var(--text); font-weight: 700; }
.link.flow-t .t-back { fill: var(--accent); font-weight: 700; }
.dr-body .refs-list { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 12px; padding: 0; list-style: none; }
.dr-body .refs-list button {
  display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 3px 8px; border-radius: 6px; cursor: pointer;
  font: inherit; font-size: 12px; color: var(--text); background: var(--surface); border: 1px solid var(--border);
}
.dr-body .refs-list button:hover { border-color: var(--accent); }
.dr-body .refs-list button svg { width: 12px; height: 12px; flex: none; color: var(--kind, var(--muted)); }
.flow-list { margin: 8px 0 0; padding: 0; list-style: none; }
.flow-list button {
  display: block; width: 100%; padding: 8px 10px; border: 0; border-radius: 6px; text-align: left; cursor: pointer;
  font: inherit; font-size: 13px; color: var(--text); background: none;
}
.flow-list button:hover { background: var(--lane); }
.link.x-account .edge { stroke: var(--x-account); stroke-opacity: 0.85; }
.link.x-account .tip { fill: var(--x-account); fill-opacity: 0.85; }
.link.e-contains .edge { stroke-opacity: 0.35; }
.link.e-loads .edge { stroke: var(--loads); stroke-opacity: 0.75; }
.link.e-loads .tip { fill: var(--loads); fill-opacity: 0.8; }
/* 근거가 확인된 로드 선은 점선으로 요청 흐름과 구분한다. 근거가 약한 선은 기존 파선이 그대로 이긴다 */
.link.e-loads .edge:not([stroke-dasharray]) { stroke-dasharray: 1 6; stroke-width: 2.5; }
.link .edge { fill: none; stroke: var(--edge); stroke-opacity: var(--edge-alpha); stroke-linecap: round; transition: stroke 0.15s, stroke-opacity 0.15s; }
.link .tip { fill: var(--edge); fill-opacity: 0.6; transition: fill 0.15s; }
.link .hit { fill: none; stroke: transparent; pointer-events: stroke; }
.link.bundle { cursor: pointer; }
.link:focus { outline: none; }
.link.lit .edge, .link:hover .edge { stroke: var(--edge-strong); stroke-opacity: 0.9; }
.link.lit .tip, .link:hover .tip { fill: var(--edge-strong); fill-opacity: 1; }
.link:focus-visible .edge { stroke: var(--accent); stroke-opacity: 1; }
.pill { opacity: 0; transition: opacity 0.15s; }
.link.lit .pill, .link:hover .pill, .link:focus-visible .pill { opacity: 1; }
.pill rect { fill: var(--surface); stroke: var(--border-strong); }
.pill text { fill: var(--text); font: 600 11px var(--font); text-anchor: middle; dominant-baseline: central; font-variant-numeric: tabular-nums; }
.level .node, .level .link { transition: opacity 0.15s, box-shadow 0.15s, border-color 0.15s; }
.dimmed .node:not(.lit), .dimmed .link:not(.lit) { opacity: 0.15; }
.searching .node:not(.hit) { opacity: 0.35; }
.empty-state { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; color: var(--muted); }
.hint {
  position: absolute; left: 16px; bottom: 16px; z-index: 5; max-width: min(560px, calc(100% - 32px));
  display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 8px 8px 8px 12px;
  font-size: 12px; color: var(--muted); background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow);
}
.hint[hidden] { display: none; }
.hint button { flex: none; border: 0; background: none; width: 20px; height: 20px; padding: 2px; border-radius: 5px; cursor: pointer; color: var(--muted); }
.hint button:hover { background: var(--surface-2); }
.hint svg { width: 16px; height: 16px; display: block; }
.drawer {
  position: absolute; top: 0; right: 0; bottom: 0; width: 380px; max-width: 100%; z-index: 15;
  display: flex; flex-direction: column; background: var(--surface); border-left: 1px solid var(--border); box-shadow: var(--shadow-pop);
  transform: translateX(100%); visibility: hidden; transition: transform 0.2s ease, visibility 0s linear 0.2s;
}
.drawer.open { transform: none; visibility: visible; transition: transform 0.2s ease; }
.dr-close { position: absolute; top: 12px; right: 12px; }
.dr-head { padding: 18px 56px 14px 20px; border-bottom: 1px solid var(--border); }
.chips { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 10px; }
.chip {
  display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; border-radius: 11px;
  font-size: 12px; font-weight: 600; color: var(--kind); background: color-mix(in srgb, var(--kind) 13%, transparent);
}
.chip svg { width: 12px; height: 12px; }
.chip.flow { --kind: var(--accent); }
.chip.flow.side { --kind: var(--warn); }
.repo { font: 11px var(--mono); color: var(--muted); word-break: break-all; }
.dr-head h2 { margin: 0; font-size: 17px; line-height: 1.4; word-break: break-word; outline: none; }
.dr-head h2 .guess { vertical-align: 2px; }
.tech { margin-top: 2px; font: 12px/1.5 var(--mono); color: var(--muted); word-break: break-all; }
.guess-note { margin: 10px 0 0; padding: 8px 10px; border-radius: 8px; font-size: 12px; line-height: 1.5; color: var(--warn); background: var(--warn-soft); }
.dr-body { flex: 1; overflow-y: auto; padding: 16px 20px 28px; }
.actions { display: flex; gap: 8px; margin-bottom: 16px; }
.actions button { flex: 1; height: 36px; border-radius: 8px; cursor: pointer; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.actions svg { width: 15px; height: 15px; }
.enter { border: 0; background: var(--accent); color: var(--on-accent); }
.enter:hover { filter: brightness(1.06); }
.actions .focus { border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); }
.actions .focus:hover { background: var(--surface-2); }
.desc { margin: 0 0 18px; line-height: 1.6; word-break: break-word; }
.dr-body h3, .pop h3 { margin: 0 0 8px; font-size: 12px; font-weight: 650; color: var(--muted); }
.evidence { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.evidence li { padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); }
.badge { display: inline-flex; align-items: center; height: 20px; padding: 0 7px; margin: 0 6px 4px 0; border-radius: 10px; font-size: 11px; font-weight: 600; vertical-align: middle; }
.badge.t-code, .badge.t-spec { color: var(--ok); background: var(--ok-soft); }
.badge.t-doc, .badge.t-user, .badge.guess { color: var(--warn); background: var(--warn-soft); }
.badge.t-live { color: var(--live); background: var(--live-soft); }
.cmd { display: block; margin-top: 4px; font: 12px/1.5 var(--mono); word-break: break-all; color: var(--text); }
.facts { list-style: none; margin: 0 0 18px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.facts li { display: flex; gap: 8px; align-items: baseline; font-size: 12.5px; }
.facts .env { flex: none; min-width: 44px; font-weight: 650; color: var(--muted); }
.facts .val { min-width: 0; word-break: break-all; }
.evidence.plat { margin-bottom: 18px; }
.evidence .evidence { margin-top: 8px; }
.loc { display: block; font: 12px/1.5 var(--mono); word-break: break-all; }
a.loc { color: var(--accent); text-decoration: none; }
a.loc:hover { text-decoration: underline; }
.ev-meta { margin-top: 4px; font-size: 11px; color: var(--muted); }
.evidence pre {
  margin: 8px 0 0; padding: 8px 10px; max-height: 220px; overflow: auto; border-radius: 6px;
  font: 11.5px/1.55 var(--mono); white-space: pre-wrap; word-break: break-word; background: var(--surface-2);
}
.empty { margin: 0; color: var(--muted); }
.pop {
  position: fixed; z-index: 40; width: 360px; max-width: calc(100vw - 16px); max-height: min(70vh, 560px); overflow-x: hidden; overflow-y: auto;
  padding: 14px 16px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow-pop);
}
.pop[hidden] { display: none; }
.pop:focus { outline: none; }
.pop ul { list-style: none; margin: 0 0 14px; padding: 0; display: grid; gap: 8px; }
.pop li { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.legend-kinds { grid-template-columns: 1fr 1fr; }
.legend-lines svg { flex: none; }
.legend-lines line { stroke: var(--edge-strong); stroke-linecap: round; }
.legend-lines line.x-account-line { stroke: var(--x-account); }
.swatch { flex: none; width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center; color: var(--kind); background: color-mix(in srgb, var(--kind) 14%, transparent); }
.swatch svg { width: 14px; height: 14px; }
.legend-kinds { grid-template-columns: 1fr !important; }
.legend-kinds .kc { flex: none; }
.pop .foot { margin: 0; padding-top: 10px; border-top: 1px solid var(--border); font-size: 11px; line-height: 1.6; color: var(--muted); }
.q-list { gap: 2px !important; }
.q-list li { display: block; }
.q {
  display: block; width: 100%; padding: 8px 10px; text-align: left; border: 0; border-radius: 8px; background: none; cursor: pointer;
}
.q:hover:not(:disabled) { background: var(--surface-2); }
.q:disabled { cursor: default; }
.q-subj { display: block; font-size: 12px; font-weight: 600; color: var(--accent); word-break: break-all; }
.q:disabled .q-subj { color: var(--muted); }
.qlist { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.q-text { display: block; margin-top: 2px; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.sheet {
  position: absolute; left: 16px; right: 16px; bottom: 16px; z-index: 10; max-height: 45%; display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow-pop);
}
.sheet[hidden] { display: none; }
.sheet summary { padding: 10px 14px; font-size: 13px; font-weight: 600; cursor: pointer; }
.sheet .scroll { overflow: auto; padding: 0 14px 12px; }
.sheet table { width: 100%; border-collapse: collapse; font-size: 12px; }
.sheet th { position: sticky; top: 0; background: var(--surface); color: var(--muted); font-weight: 600; text-align: left; }
.sheet th, .sheet td { padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; text-align: left; }
.sheet td .loc { font-size: 11px; }
.sheet th:first-child, .sheet td:first-child { white-space: nowrap; }
@media (max-width: 900px) {
  .meta, .bar h1 { display: none; }
  .crumbs::before { display: none; }
  .search { width: 160px; }
  .btn .label { display: none; }
}
@media (max-width: 560px) {
  .bar { gap: 6px; padding: 0 8px 0 12px; }
  .seg, #zoom-fit, .spacer { display: none; }
  .search { width: auto; flex: 1; min-width: 0; }
  .search input { width: 100%; }
  .drawer { width: 100%; }
  .hint { display: none; }
}
`;

/** 테마 토큰과 레이아웃 CSS. 시스템 설정을 기본으로 따르고 html의 data-theme가 있으면 그걸 따른다 */
export function renderCss(): string {
  return [
    `:root {${LIGHT_TOKENS}  --font: "Pretendard", -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Segoe UI", sans-serif;\n  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;\n}`,
    `@media (prefers-color-scheme: dark) {\n:root:not([data-theme="light"]) {${DARK_TOKENS}}\n${scoped(':root:not([data-theme="light"])', 'dark')}\n}`,
    `:root[data-theme="dark"] {${DARK_TOKENS}}`,
    kindRules('light'),
    brandRules('light'),
    productRules(),
    scoped(':root[data-theme="dark"]', 'dark'),
    LAYOUT_CSS,
  ].join('\n');
}

function scoped(prefix: string, theme: 'light' | 'dark'): string {
  return (
    kindRules(theme).replace(/\.k-/g, `${prefix} .k-`) +
    brandRules(theme).replace(/\.b-/g, `${prefix} .b-`)
  );
}
