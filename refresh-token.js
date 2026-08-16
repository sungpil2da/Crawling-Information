import { refreshAccessToken } from '../../lib/ig.js';

/**
 * 장기 액세스 토큰은 60일 뒤 만료된다.
 * 매주 갱신해두면 휴가를 다녀와도 자동화가 조용히 멈춰 있는 일이 없다.
 */
export default async () => {
  try {
    const { expiresInDays } = await refreshAccessToken();
    console.log(`토큰 갱신 완료. 남은 유효기간 약 ${expiresInDays}일`);
  } catch (err) {
    console.error('토큰 갱신 실패:', err.message);
  }
};

export const config = { schedule: '0 3 * * 1' }; // 매주 월요일 03:00 UTC
