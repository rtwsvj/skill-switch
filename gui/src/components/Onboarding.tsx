import { useTranslation } from 'react-i18next';

// v0.3 A1:首启引导卡 —— 大白话欢迎 + 三句「去哪做什么」+「知道了」。直击 #1 onboarding 弱项(P1)。
export function Onboarding({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useTranslation();
  const points = t('onboarding.points', { returnObjects: true });
  const list = Array.isArray(points) ? (points as string[]) : [];
  return (
    <section className="panel onboarding-card">
      <div className="panel-title">
        <h2>{t('onboarding.title')}</h2>
        <button type="button" className="ghost-button" onClick={onDismiss}>{t('onboarding.dismiss')}</button>
      </div>
      <p>{t('onboarding.intro')}</p>
      <ul className="onboarding-points">
        {list.map((point, index) => (
          <li key={index}>{point}</li>
        ))}
      </ul>
    </section>
  );
}
