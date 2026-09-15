/**
 * 网站公安备案（联网备案）悬挂位。
 *
 * 合规依据：《计算机信息网络国际联网安全保护管理办法》（1997 年公安部令第 33 号）第十一条、
 * 第十二条 —— 使用单位应当自网络正式联通之日起 30 日内，到所在地省级公安机关办理联网备案；
 * 备案后应当在网站首页底部显著位置悬挂「备案图标」与「备案编号」，并链接至
 * 全国互联网安全管理服务平台（https://beian.mps.gov.cn），供公众查询核对。
 *
 * 与 ICP 备案（工信部，非经营性网站管理办法第十三条）分属两套法定要求，故单列组件，
 * 互不耦合。备案号是法定标识，不随界面语言切换，因此不进 i18n 文案文件。
 */

/** 安徽芜湖（皖）公安联网备案编号。 */
export const PUBLIC_SECURITY_FILING_NUMBER = "皖公网安备34020702000820号";

/** 全国互联网安全管理服务平台 —— 联网备案公众查询入口（code 为备案编号本体）。 */
export const PUBLIC_SECURITY_FILING_URL =
  "https://beian.mps.gov.cn/#/query/webSearch?code=34020702000820";

type PublicSecurityFilingLinkProps = {
  className?: string;
};

export function PublicSecurityFilingLink({
  className = ""
}: PublicSecurityFilingLinkProps) {
  return (
    <a
      href={PUBLIC_SECURITY_FILING_URL}
      target="_blank"
      rel="noreferrer"
      className={`group inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${className}`}
    >
      {/*
        公安备案图标：盾牌徽章 + 五角星，对应全国互联网安全管理服务平台
        备案图标的视觉语义；currentColor 跟随文本色，hover 时整体轻微变深，
        与 IcpFiling 的 ICP 盾牌徽章保持同一视觉语言。
      */}
      <svg
        width="13"
        height="14"
        viewBox="0 0 13 14"
        aria-hidden="true"
        className="shrink-0 transition-transform duration-200 group-hover:-translate-y-px"
      >
        <path
          d="M6.5 1 L11 2.7 L11 7.2 C11 10 9.1 12.1 6.5 12.9 C3.9 12.1 2 10 2 7.2 L2 2.7 Z"
          stroke="currentColor"
          strokeWidth="1.1"
          fill="none"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <path
          d="M6.5 4.1 L7.35 5.75 L9.1 6 L7.9 7.2 L8.3 8.95 L6.5 7.95 L4.7 8.95 L5.1 7.2 L3.9 6 L5.65 5.75 Z"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth="0.4"
          strokeLinejoin="round"
        />
      </svg>
      {/*
        强制走 CJK 字体并启用 tabular-nums，让「皖/备/号」与「34020702000820」
        共享同一套字模与基线，避免混排 Inter 数字 + Noto Sans SC 汉字导致的视觉参差
        （与 IcpFiling 同一根因、同一解法）。
      */}
      <span
        className="leading-none"
        style={{
          fontFamily:
            '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
          fontFeatureSettings: '"tnum" 1, "kern" 1',
          fontVariantNumeric: "tabular-nums"
        }}
      >
        {PUBLIC_SECURITY_FILING_NUMBER}
      </span>
    </a>
  );
}

export default PublicSecurityFilingLink;
