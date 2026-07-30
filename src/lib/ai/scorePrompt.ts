// The one prompt every vision engine sends. Gemini, OpenRouter and Hugging
// Face all ask for the same JSON shape, so the wording lives here instead of
// being copied into each client — a fix to how a score is read then reaches
// every model in the pool at once.

/**
 * How to read a page whose staves carry more than one row of lyrics.
 *
 * This is the failure mode that costs the most accuracy in practice: when 1절
 * and 2절 are printed as stacked rows under a shared staff, a model that reads
 * the page in normal left-to-right, top-to-bottom order concatenates them into
 * a single verse. The rule below asks for the opposite traversal — collect the
 * n-th row of every staff — and shows a worked example, because stating the
 * rule alone was not enough to stop the merge.
 */
const STACKED_ROW_RULES = [
  '【절이 여러 개인 악보 — 가장 자주 틀리는 부분이니 특히 주의하세요】',
  '한 오선(스태프) 아래에 가사 줄이 위아래로 2줄 이상 쌓여 있으면, 같은 멜로디를 절을 바꿔 가며',
  '여러 번 부르라는 뜻입니다. 위아래 줄은 서로 다른 절이며 절대로 한 파트로 이어 붙이면 안 됩니다.',
  '읽는 방향이 중요합니다. 페이지 전체를 훑으면서 "같은 높이의 줄끼리" 모으세요:',
  '  · 모든 오선의 첫째 가사 줄을 순서대로 모아 1절(V)',
  '  · 모든 오선의 둘째 가사 줄을 순서대로 모아 2절(V2)',
  '  · 셋째 줄이 있으면 3절(V3), 넷째 줄이 있으면 4절(V4)',
  '오선 하나를 읽은 뒤 바로 그 아래 줄로 내려가 같은 파트에 붙이지 마세요.',
  '가사 줄 맨 앞의 "1." "2." "3." 숫자는 절 번호입니다. 가사가 아니므로 lines에 넣지 말고,',
  '같은 숫자가 붙은 줄끼리 한 파트로 모으는 근거로 사용하세요.',
  '이 규칙은 절뿐 아니라 어떤 파트에도 똑같이 적용됩니다: 절이면 V, V2…, 후렴이면 C, C2…,',
  '프리코러스면 PC, PC2…, 브릿지면 B, B2…, 아웃트로면 O, O2… 순서로 라벨을 매기세요 (첫 줄은 번호 없이).',
  '',
  '예시 — 오선이 두 개이고 각 오선 아래에 가사가 두 줄씩 쌓인 악보:',
  '  (오선1)  1. 주 사랑이 나를 숨쉬게 해',
  '           2. 주 사랑이 나를 이끄시네',
  '  (오선2)  1. 세상 그 어떤 어려움 속에도',
  '           2. 내가 갈 수 없는 그 곳으로',
  '올바른 sections:',
  '  {"label":"V","lines":["주 사랑이 나를 숨쉬게 해","세상 그 어떤 어려움 속에도"]}',
  '  {"label":"V2","lines":["주 사랑이 나를 이끄시네","내가 갈 수 없는 그 곳으로"]}',
  '금지된 결과: 네 줄을 한 파트에 모두 넣기, 또는 오선 순서대로 1절·2절을 번갈아 섞어 넣기.',
  '',
  '오선 "위"에 그려진 「1.」「2.」 꺾쇠(볼타) 괄호는 이것과 다릅니다. 도돌이표의 첫 번째·두 번째',
  '끝맺음 마디를 뜻하므로, 그 안의 가사는 같은 파트에서 이어지는 가사입니다. 볼타 괄호를 보고',
  '새 파트를 만들지 마세요.',
  '',
  '한 페이지에 이렇게 쌓인 묶음이 두 개 이상 나올 수 있습니다(예: 절 묶음 다음에 후렴 묶음).',
  '묶음은 오선 그룹이 바뀌는 곳에서 새로 시작합니다. 앞 묶음의 아래쪽 줄을 다음 묶음까지',
  '끌고 가지 말고, 다음 묶음의 줄을 앞 파트에 붙이지도 마세요. 후렴 묶음의 둘째·셋째 줄이',
  '절 파트로 들어가는 것이 가장 흔한 실수입니다.',
  '같은 파트의 쌓인 줄들은 같은 오선을 나눠 쓰므로, 번호만 다른 같은 파트끼리는 lines 개수가',
  '서로 같아야 합니다. 답을 내기 전에 개수가 어긋나지 않았는지 확인하세요.',
  '',
  '【축을 반대로 잡는 실수 — 절이 3개 이상일 때 특히 조심하세요】',
  '절이 3개, 오선이 2개인 악보를 예로 들면:',
  '  (오선1)  1. 첫째 절 첫 줄',
  '           2. 둘째 절 첫 줄',
  '           3. 셋째 절 첫 줄',
  '  (오선2)  1. 첫째 절 둘째 줄',
  '           2. 둘째 절 둘째 줄',
  '           3. 셋째 절 둘째 줄',
  '올바른 sections — 절의 개수(3)만큼 파트를 만들고, 각 파트는 오선 개수(2)만큼 줄을 갖습니다:',
  '  {"label":"V","lines":["첫째 절 첫 줄","첫째 절 둘째 줄"]}',
  '  {"label":"V2","lines":["둘째 절 첫 줄","둘째 절 둘째 줄"]}',
  '  {"label":"V3","lines":["셋째 절 첫 줄","셋째 절 둘째 줄"]}',
  '절대로 하면 안 되는 결과 — 오선 하나에 쌓인 줄들을 그대로 한 파트에 담는 것:',
  '  {"label":"V","lines":["첫째 절 첫 줄","둘째 절 첫 줄","셋째 절 첫 줄"]}  ← 틀렸습니다',
  '  {"label":"V2","lines":["첫째 절 둘째 줄","둘째 절 둘째 줄","셋째 절 둘째 줄"]}  ← 틀렸습니다',
  '이 실수는 숫자로 바로 알아볼 수 있습니다. 한 파트의 lines 개수가 오선 묶음의 개수가 아니라',
  '절의 개수와 같아졌다면 축을 반대로 잡은 것이니, 행 기준으로 다시 모으세요.',
];

/** The shared instruction block, as individual lines so callers can extend it. */
export const BASE_PROMPT_LINES: string[] = [
  '이 이미지는 한국어 찬양 콘티 PDF의 한 페이지이며, 악보가 아닐 수도 있습니다.',
  '먼저 오선과 음표가 실제로 보이는지 확인해 페이지 종류를 분류하세요.',
  '다음을 읽어 JSON으로만 답하세요:',
  '- pageType: 오선과 음표가 있는 악보 페이지면 "score", 아니면 "non_score".',
  '- sermonTitle: non_score 페이지에 명시된 설교 제목. 없으면 빈 문자열.',
  '- scripture: non_score 페이지에 명시된 본문 성경 구절/범위. 없으면 빈 문자열.',
  'pageType이 "score"일 때만 아래 찬양 필드를 읽으세요:',
  '- title: 곡 제목',
  '- key: 조성(예: E, F, F#m). 안 보이면 빈 문자열.',
  '- order: 악보 맨 위의 진행 순서. 보통 I(간주)로 시작합니다. 예: ["I","V","V2","PC","C","C"]. 없으면 빈 배열.',
  '- lyricRowCount: 한 오선 아래에 가사 줄이 가장 많이 쌓여 있는 개수(1, 2, 3…). 악보가 아니면 0.',
  '- sections: 가사를 파트별로 나눈 배열. 각 원소는 {label, lines}.',
  '  label은 V(절), PC(프리코러스), C(후렴), B(브릿지), O(아웃트로) 등입니다.',
  '  같은 파트가 한 번뿐이면 번호 없이 그대로 쓰고(V, PC, C, B, O), 여러 번 있을 때만 두 번째부터',
  '  번호를 붙이세요(V, V2, V3… / C, C2, C3… 등). 콘티에 1, 2 구분이 없는데 임의로 1을 붙이지 마세요.',
  '  lines는 그 파트의 가사를 한 줄씩 담은 문자열 배열입니다.',
  '악보에 보이는 가사를 빠짐없이 모두 읽으세요. 도돌이표와 1., 2. 괄호(볼타) 안의 가사도 포함하세요.',
  '악보의 코드 기호(C, G, Am7, G/B 등)와 반복 기호는 가사가 아닙니다. lines에 절대 포함하지 마세요.',
  ...STACKED_ROW_RULES,
  '가사는 음절을 나누는 하이픈(-)이나 붙임표 없이 단어를 자연스럽게 이어서 적으세요',
  '(예: "Ce-le-brate" → "Celebrate", "찬-양-해" → "찬양해").',
  '같은 가사 줄이 연달아 여러 번 인쇄되어 있으면 인쇄된 횟수만큼 그대로 반복해서 넣으세요.',
  '중복이라고 판단해 한 번으로 줄이지 마세요.',
  '가사에 없는 내용을 지어내지 말고, 확신이 없는 글자도 보이는 대로 최대한 읽으세요.',
  'pageType이 "non_score"이면 title과 key는 빈 문자열, order와 sections는 빈 배열,',
  'lyricRowCount는 0으로 반환하세요.',
  'non_score 페이지에서는 다른 안내문을 추측하지 말고 설교 제목과 본문만 옮기세요.',
  '',
  '답을 내보내기 전에 스스로 확인하세요:',
  '(1) lyricRowCount가 2 이상이면 sections에는 번호만 다른 같은 종류의 파트가 최소 lyricRowCount개',
  '    있어야 합니다(2면 V와 V2, 3이면 V와 V2와 V3). 한 파트로 합쳐져 있으면 다시 나누세요.',
  '(2) 어떤 파트의 lines 안에 서로 다른 절의 가사가 섞여 있지 않은지 확인하세요.',
  '(3) 쌓인 묶음에서 각 파트의 lines 개수가 그 묶음의 오선 개수와 같은지 확인하세요.',
  '    lines 개수가 절의 개수와 같아졌다면 축을 반대로 잡은 것입니다.',
];

/**
 * Extra instructions when Google Search grounding is enabled. The web is used
 * ONLY to fix spacing/spelling and to join the note-split syllables correctly —
 * NOT to change the actual words. The lyric content must stay faithful to the
 * score even if a web version words it differently.
 */
export const SEARCH_PROMPT_LINES: string[] = [
  '가사의 단어와 내용은 반드시 악보(이미지)에 적힌 그대로 옮기세요.',
  '웹 검색 결과로 단어·표현·가사 내용을 바꾸지 마세요. 웹 버전이 달라도 악보를 따릅니다.',
  '웹 검색은 오직 다음 세 가지에만 사용하세요:',
  '(1) 음표에 맞춰 하이픈(-)으로 쪼개진 음절을 올바른 단어 경계로 이어 붙이기,',
  '(2) 띄어쓰기와 맞춤법(문법)을 바로잡기,',
  '(3) 절이 여러 개인 곡에서 1절과 2절의 경계가 어디인지 확인하기.',
  '즉, 내용은 악보를 그대로 따르고 표기(띄어쓰기·맞춤법·하이픈 정리)와 절 구분만 웹으로 확인합니다.',
  '반드시 유효한 JSON 객체 하나만 출력하고, 다른 설명이나 마크다운(```)은 넣지 마세요.',
];

/** The shared instruction block as one string, plus any engine-specific tail. */
export function basePrompt(...extraLines: string[]): string {
  return [...BASE_PROMPT_LINES, ...extraLines].join('\n');
}
