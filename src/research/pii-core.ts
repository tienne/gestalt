/**
 * 개인정보 탐지와 가짜 값 치환 코어.
 *
 * Node(이미지 경로의 OCR 결과 글자)와 브라우저(DOM 글자)가 같은 구현을 쓰도록 소스 문자열로
 * 둔다. `Function.toString()`으로 뽑지 않는 건 번들러가 함수 안에 헬퍼를 끼워 넣어 브라우저에서
 * 깨지기 때문이다. 이 문자열은 `node:vm`과 `page.evaluate` 양쪽에서 그대로 평가된다.
 *
 * 규칙
 * - 실제 값과 가명의 대응표를 만들지 않는다. 가명은 `seed + 종류 + 정규화한 값`의 해시로
 *   정해서, 같은 값이면 같은 가명이 나오지만 가명에서 실제 값을 되돌릴 수 없다.
 * - 이 소스 안에서 백틱과 `${`를 쓰지 않는다. String.raw가 깨진다.
 * - 못 잡는 것: 라벨 없는 이름, 성씨 목록 밖의 이름, 사진 속 글자가 아닌 정보. `pii: none`은
 *   "탐지기가 돌았고 0건"이라는 뜻이지 개인정보가 없다는 보증이 아니다.
 */
export const PII_CORE_SOURCE = String.raw`(function () {
  var SURNAMES = '김이박최정강조윤장임한오서신권황안송류전홍고문양손배백허유남심노하곽성차주우구민나진지엄채원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제모탁국어은편용';
  var COMPOUND_SURNAMES = ['남궁', '선우', '독고', '황보', '제갈', '사공', '서문', '동방'];
  var NOT_NAMES = ['고객', '선생', '손님', '구매', '이용', '기사', '주인', '입력', '필수', '선택', '확인', '정보', '변경', '등록', '수정', '삭제', '조회', '주문', '배송', '전체', '회원', '사용', '결제', '인증', '번호', '주소', '이름', '성명', '연락'];
  var POOL = {
    2: ['이솔', '김하', '박온', '최윤', '정서', '강율', '조안', '한결'],
    3: ['홍길동', '김철수', '이영희', '박민수', '최지우', '정수민', '강다은', '조현우', '윤서연', '한지민'],
    4: ['남궁민수', '선우지안', '독고서진', '황보라희', '제갈민준', '사공유나', '서문하늘', '동방지후']
  };
  var LABELS = {
    name: '이름|성명|성함|수령인|받는\\s?분|보내는\\s?분|예금주|구매자|주문자|수취인|대표자|대표이사|대표(?=\\s*[:：])',
    birth: '생년월일|생일',
    address: '주소|배송지|배송\\s?주소|도로명',
    account: '환불\\s?계좌|입금\\s?계좌|계좌\\s?번호|계좌',
    order: '주문\\s?번호|예약\\s?번호|승인\\s?번호|운송장\\s?번호|거래\\s?번호',
    biz: '사업자\\s?등록\\s?번호|사업자\\s?번호|법인\\s?등록\\s?번호|통신판매업\\s?신고(?:\\s?번호)?|통신판매업\\s?번호',
    gift: '바코드(?:\\s?번호)?|PIN(?:\\s?번호)?|핀\\s?번호|쿠폰\\s?번호|교환\\s?번호|인증\\s?번호|시리얼(?:\\s?번호)?|상품권\\s?번호|기프티콘\\s?번호',
    phone: '전화번호|휴대폰(?:\\s?번호)?|핸드폰(?:\\s?번호)?|연락처|전화',
    email: '이메일|메일'
  };
  var LABEL_ONLY = {};
  var LABEL_INLINE = {};
  Object.keys(LABELS).forEach(function (kind) {
    LABEL_ONLY[kind] = new RegExp('^(?:' + LABELS[kind] + ')\\s*[:：]?$');
  });
  var VALUE_PATTERNS = {
    name: '[가-힣]{2,4}',
    birth: '\\d{4}[.\\-/년 ]+\\d{1,2}[.\\-/월 ]+\\d{1,2}일?|\\d{8}|\\d{6}',
    address: '[^\\n]{4,100}',
    account: '\\d[\\d-]{7,24}\\d',
    order: '[A-Za-z0-9-]{6,32}',
    biz: '[0-9][0-9A-Za-z가-힣-]{5,28}',
    gift: '[A-Za-z0-9][A-Za-z0-9 -]{4,30}[A-Za-z0-9]',
    phone: '\\+?[\\d][\\d .-]{7,16}\\d',
    email: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}'
  };
  Object.keys(LABELS).forEach(function (kind) {
    LABEL_INLINE[kind] = new RegExp('(?:' + LABELS[kind] + ')(?:\\s*[:：]\\s*|\\s+)(' + VALUE_PATTERNS[kind] + ')(님)?', 'dg');
  });

  var NIM_NAME = /(?<![가-힣])([가-힣]{2,4})님/dg;
  var MASKED_NIM_NAME = /(?<![가-힣])([가-힣]{1,3}[*＊○●]{1,2}[가-힣]{0,2})님/dg;
  var EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  var PHONE = /(?<!\d)(?:\+82[-. ]?)?0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}(?!\d)/g;
  var RRN = /(?<!\d)\d{6}[- ]?[1-8]\d{6}(?!\d)/g;
  var CARD = /(?<!\d)(?:\d{4}[- ]){3}\d{4}(?!\d)|(?<!\d)\d{16}(?!\d)/g;
  var LONG_CODE = /(?<!\d)\d{4}(?:[- ]?\d{4}){2,}(?!\d)/g;
  var ROAD_ADDRESS = /[가-힣]{2,6}(?:특별시|광역시|특별자치시|특별자치도|도|시)\s[가-힣]{1,6}(?:시|군|구)\s[가-힣0-9]{1,12}(?:로|길)\s?\d{1,4}(?:-\d{1,4})?(?:\s?[0-9가-힣-]{1,12}(?:동|호|층))*/g;

  function hashString(str, seedNum) {
    var h1 = 0xdeadbeef ^ seedNum;
    var h2 = 0x41c6ce57 ^ seedNum;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  function pad(n, width) {
    var s = String(n);
    while (s.length < width) s = '0' + s;
    return s;
  }

  function startsWithSurname(word) {
    if (word.length >= 4 && COMPOUND_SURNAMES.indexOf(word.slice(0, 2)) >= 0) return true;
    return SURNAMES.indexOf(word.charAt(0)) >= 0;
  }

  function plausibleName(word) {
    if (!/^[가-힣]{2,4}$/.test(word)) return false;
    if (NOT_NAMES.indexOf(word.slice(0, 2)) >= 0) return false;
    return startsWithSurname(word);
  }

  function plausibleMaskedName(word) {
    if (word.length > 4) return false;
    if (NOT_NAMES.indexOf(word.slice(0, 2)) >= 0) return false;
    return startsWithSurname(word);
  }

  function createPii(seed) {
    var seedNum = hashString(String(seed), 7) % 2147483647;

    function keyed(kind, value) {
      return hashString(kind + '\u0000' + value, seedNum);
    }
    function tail4(kind, value) {
      return pad(keyed(kind, value) % 10000, 4);
    }
    function digitsOf(text) {
      return text.replace(/\D/g, '');
    }

    function fakePhone(value) {
      var key = digitsOf(value);
      var groups = value.split(/(\d+)/);
      var numericIdx = [];
      for (var i = 0; i < groups.length; i++) if (/^\d+$/.test(groups[i])) numericIdx.push(i);
      var tail = tail4('phone', key);
      if (numericIdx.length === 1) {
        var only = groups[numericIdx[0]];
        var head = only.length <= 10 && only.indexOf('02') === 0 ? 2 : 3;
        groups[numericIdx[0]] = only.slice(0, head) + new Array(only.length - head - 3).join('0') + tail;
        return groups.join('');
      }
      var keep = value.indexOf('+82') === 0 ? 2 : 1;
      for (var j = keep; j < numericIdx.length; j++) {
        var idx = numericIdx[j];
        groups[idx] = j === numericIdx.length - 1 ? tail : new Array(groups[idx].length + 1).join('0');
      }
      return groups.join('');
    }

    function fakeEmail(value) {
      var h = keyed('email', value.toLowerCase());
      return 'user' + (100 + (h % 900)) + '@example.com';
    }

    function fakeName(word, suffix) {
      var len = word.length;
      var list = POOL[len] || POOL[3];
      return list[keyed('name', word) % list.length] + (suffix || '');
    }

    function fakeDateParts(value) {
      var h = keyed('date', digitsOf(value));
      return { y: 1975 + (h % 30), m: 1 + (Math.floor(h / 30) % 12), d: 1 + (Math.floor(h / 360) % 28) };
    }

    function fakeBirth(value) {
      var p = fakeDateParts(value);
      var m = /^(\d{4})([.\-/년 ]+)(\d{1,2})([.\-/월 ]+)(\d{1,2})(일?)$/.exec(value);
      if (m) {
        var mm = m[3].length === 2 ? pad(p.m, 2) : String(p.m);
        var dd = m[5].length === 2 ? pad(p.d, 2) : String(p.d);
        return p.y + m[2] + mm + m[4] + dd + m[6];
      }
      if (/^\d{8}$/.test(value)) return p.y + pad(p.m, 2) + pad(p.d, 2);
      if (/^\d{6}$/.test(value)) return pad(p.y % 100, 2) + pad(p.m, 2) + pad(p.d, 2);
      return value.replace(/\d/g, '0');
    }

    function fakeRrn(value) {
      var p = fakeDateParts(value);
      var sep = /[- ]/.exec(value);
      return pad(p.y % 100, 2) + pad(p.m, 2) + pad(p.d, 2) + (sep ? sep[0] : '') + '1000000';
    }

    function maskDigits(kind, value, keepLetters) {
      var key = kind + ':' + value.replace(/[^A-Za-z0-9]/g, '');
      var tail = tail4(kind, key);
      var total = 0;
      for (var i = 0; i < value.length; i++) if (/\d/.test(value.charAt(i))) total++;
      var seen = 0;
      var out = '';
      for (var k = 0; k < value.length; k++) {
        var c = value.charAt(k);
        if (/\d/.test(c)) {
          seen++;
          out += total >= 4 && seen > total - 4 ? tail.charAt(seen - (total - 4) - 1) : '0';
        } else if (/[A-Za-z]/.test(c)) {
          out += keepLetters ? c : 'X';
        } else {
          out += c;
        }
      }
      return out;
    }

    function fakeCard(value) {
      return maskDigits('card', value, true);
    }

    function fakeAddress(value) {
      var h = keyed('address', value.replace(/\s+/g, ''));
      return '서울특별시 샘플구 예시로 ' + (10 + (h % 90));
    }

    function fakeDigits(value) {
      return maskDigits('barcode', value, false);
    }

    function validAddressValue(value) {
      return /[가-힣]/.test(value) && /\d/.test(value);
    }

    var REPLACERS = {
      email: function (v) { return fakeEmail(v); },
      phone: function (v) { return fakePhone(v); },
      card: function (v) { return fakeCard(v); },
      birth: function (v) { return fakeBirth(v); },
      address: function (v) { return fakeAddress(v); },
      account: function (v) { return maskDigits('account', v, true); },
      order: function (v) { return maskDigits('order', v, true); },
      biz: function (v) { return maskDigits('biz', v, true); },
      gift: function (v) { return maskDigits('gift', v, false); }
    };

    /** 글 한 덩어리에서 개인정보 구간을 찾는다. ctxKind가 있으면 글 전체를 그 종류의 값으로 본다 */
    function detect(text, ctxKind) {
      var found = [];
      function add(kind, start, end, replacement) {
        if (replacement !== text.slice(start, end)) found.push({ kind: kind, start: start, end: end, replacement: replacement });
      }

      if (ctxKind) {
        var lead = text.length - text.replace(/^\s+/, '').length;
        var body = text.trim();
        if (body) {
          if (ctxKind === 'name') {
            var suffix = /님$/.test(body) ? '님' : '';
            var word = suffix ? body.slice(0, -1) : body;
            if (plausibleName(word)) add('name', lead, lead + body.length, fakeName(word, suffix));
          } else if (ctxKind === 'address') {
            if (validAddressValue(body)) add('address', lead, lead + body.length, fakeAddress(body));
          } else if (REPLACERS[ctxKind] && /\d|@/.test(body)) {
            add(ctxKind, lead, lead + body.length, REPLACERS[ctxKind](body));
          }
        }
      }

      var m;
      Object.keys(LABEL_INLINE).forEach(function (kind) {
        var re = new RegExp(LABEL_INLINE[kind].source, 'dg');
        while ((m = re.exec(text)) !== null) {
          var value = m[1];
          var span = m.indices[1];
          if (kind === 'name') {
            var nameSuffix = m[2] || '';
            var nameWord = value;
            if (!nameSuffix && value.length >= 3 && /님$/.test(value)) {
              nameSuffix = '님';
              nameWord = value.slice(0, -1);
            }
            if (plausibleName(nameWord)) add('name', span[0], span[1] + (m[2] ? 1 : 0), fakeName(nameWord, nameSuffix));
          } else if (kind === 'address') {
            if (validAddressValue(value)) add('address', span[0], span[1], fakeAddress(value));
          } else if (kind === 'birth' || kind === 'phone' || kind === 'account' || kind === 'order' || kind === 'biz' || kind === 'gift' || kind === 'email') {
            if (/\d|@/.test(value)) add(kind, span[0], span[1], REPLACERS[kind](value));
          }
          if (m[0].length === 0) re.lastIndex++;
        }
      });

      var re2 = new RegExp(NIM_NAME.source, 'dg');
      while ((m = re2.exec(text)) !== null) {
        if (plausibleName(m[1])) add('name', m.indices[1][0], m.indices[0][1], fakeName(m[1], '님'));
      }
      var re3 = new RegExp(MASKED_NIM_NAME.source, 'dg');
      while ((m = re3.exec(text)) !== null) {
        if (plausibleMaskedName(m[1])) add('name', m.indices[1][0], m.indices[0][1], fakeName(m[1], '님'));
      }
      EMAIL.lastIndex = 0;
      while ((m = EMAIL.exec(text)) !== null) {
        if (!/@example\.com$/i.test(m[0])) add('email', m.index, m.index + m[0].length, fakeEmail(m[0]));
      }
      [[PHONE, 'phone', fakePhone], [RRN, 'rrn', fakeRrn], [CARD, 'card', fakeCard], [ROAD_ADDRESS, 'address', fakeAddress], [LONG_CODE, 'gift', function (v) { return maskDigits('gift', v, false); }]].forEach(function (entry) {
        var re3 = new RegExp(entry[0].source, 'g');
        while ((m = re3.exec(text)) !== null) {
          add(entry[1], m.index, m.index + m[0].length, entry[2](m[0]));
        }
      });

      found.sort(function (a, b) { return a.start - b.start || (b.end - b.start) - (a.end - a.start); });
      var kept = [];
      var lastEnd = -1;
      found.forEach(function (f) {
        if (f.start >= lastEnd) {
          kept.push(f);
          lastEnd = f.end;
        }
      });
      return kept;
    }

    function apply(text, spans) {
      var out = '';
      var pos = 0;
      spans.forEach(function (s) {
        out += text.slice(pos, s.start) + s.replacement;
        pos = s.end;
      });
      return out + text.slice(pos);
    }

    function redactText(text, ctxKind) {
      var spans = detect(text, ctxKind);
      return { text: spans.length ? apply(text, spans) : text, spans: spans };
    }

    function labelKindOf(text) {
      var t = text.trim();
      if (t.length === 0 || t.length > 14) return null;
      var kinds = Object.keys(LABEL_ONLY);
      for (var i = 0; i < kinds.length; i++) if (LABEL_ONLY[kinds[i]].test(t)) return kinds[i];
      return null;
    }

    function kindFromHints(hints) {
      var h = String(hints).toLowerCase();
      if (/email|e-mail|이메일/.test(h)) return 'email';
      if (/tel|phone|mobile|휴대폰|전화|연락처/.test(h)) return 'phone';
      if (/bday|birth|생년|생일/.test(h)) return 'birth';
      if (/street|address|addr|주소|배송지/.test(h)) return 'address';
      if (/cc-number|card|카드/.test(h)) return 'card';
      if (/account|계좌/.test(h)) return 'account';
      if (/order|주문|예약/.test(h)) return 'order';
      if (/business|사업자|법인|통신판매/.test(h)) return 'biz';
      if (/pin|barcode|coupon|gift|바코드|쿠폰|핀|교환|인증번호/.test(h)) return 'gift';
      if (/name|이름|성명|수령|받는|예금주|대표자|대표이사/.test(h)) return 'name';
      return null;
    }

    return {
      detect: detect,
      redactText: redactText,
      labelKindOf: labelKindOf,
      kindFromHints: kindFromHints,
      fakeDigits: fakeDigits,
      hash: function (kind, value) { return keyed(kind, value); }
    };
  }

  return createPii;
})()`;
