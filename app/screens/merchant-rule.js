// =====================================================================
// 분류한 뒤 가맹점 규칙 저장 — 가맹점별 분류(CL-061)와 월 검토(CL-066)가 같이 쓴다
// - 같은 패턴(방식·정리값)의 켜진 규칙이 있으면 만들지 않는다(category_rules에 유일 제약이 없음 — CL-061 리뷰 ④)
//   같은 카테고리면 '이미 있어요', 다른 카테고리면 규칙 화면에서 바꾸도록 링크(같은 패턴 두 규칙이 다투지 않게)
// - 없으면 category_rules insert(created_by = 나)
// 의존: router.js, core/errors.js, screens/merchant-classify-model.js
// =====================================================================
import { buildHash } from '../router.js';
import { STAGES } from '../core/errors.js';
import { samePatternRule } from './merchant-classify-model.js';

const eq = (col, value) => ({ col, op: 'eq', value });

/**
 * @param {{ db, member, value, categories, onError }} ctx  value = ruleFor(...).value
 * @returns {Promise<{ ok: true, note: string, link: { href, text }|null } | { ok: false, text: string }>}
 *   note: 분류 안내 뒤에 붙일 글(앞에 공백 포함). 실패 text: '규칙은 …' 으로 시작하는 글(오류 번호 포함)
 */
export async function saveMerchantRule({ db, member, value, categories, onError }) {
  const ex = await db.select('category_rules', {
    columns: 'id,pattern,match_type,category_id,is_active',
    filters: [eq('is_active', true), eq('match_type', value.match_type)],
  });
  if (ex.error) {
    const code = onError?.(ex.error, { stage: STAGES.list });
    return { ok: false, text: `같은 규칙이 있는지 확인하지 못해 규칙은 만들지 않았어요. 규칙·카테고리에서 만들어 주세요.${code ? ` (오류 번호 ${code})` : ''}` };
  }
  const found = samePatternRule(ex.data, value);
  if (found.same) return { ok: true, note: ' 같은 규칙이 이미 있어요.', link: null };
  if (found.other) {
    const other = (categories ?? []).find((c) => c.id === found.other.category_id)?.name ?? '다른 카테고리';
    return {
      ok: true,
      note: ` 이미 「${found.other.pattern}」 규칙이 '${other}'(으)로 있어 새 규칙은 만들지 않았어요 —`,
      link: { href: buildHash('rule', { id: found.other.id }), text: '규칙 화면에서 바꾸기' },
    };
  }
  const ir = await db.insert('category_rules', { ...value, created_by: member.memberId });
  if (ir.error) {
    if (ir.error.code === 'duplicate') return { ok: true, note: ' 같은 규칙이 이미 있어요.', link: null };
    const code = onError?.(ir.error, { stage: STAGES.db_update });
    return { ok: false, text: `규칙은 만들지 못했어요. 규칙·카테고리에서 만들어 주세요.${code ? ` (오류 번호 ${code})` : ''}` };
  }
  return { ok: true, note: ' 앞으로 올릴 때 자동 분류돼요.', link: null };
}
