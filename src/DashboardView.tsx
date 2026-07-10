import React from 'react';
import { TopicDashboard, DashboardKeyPoint, SearchSource, DashboardImage } from './types';

// ============================================
// RICH TEXT — renders ==highlight== and **bold**
// ============================================

export function richText(text: string, highlightsEnabled: boolean): React.ReactNode[] {
    const nodes: React.ReactNode[] = [];
    const pattern = /(==[^=]+==|\*\*[^*]+\*\*)/g;
    const parts = text.split(pattern);
    parts.forEach((part, i) => {
        if (part.startsWith('==') && part.endsWith('==')) {
            const inner = part.slice(2, -2);
            nodes.push(highlightsEnabled
                ? <mark key={i} className="hl">{inner}</mark>
                : <strong key={i}>{inner}</strong>);
        } else if (part.startsWith('**') && part.endsWith('**')) {
            nodes.push(<strong key={i}>{part.slice(2, -2)}</strong>);
        } else if (part) {
            nodes.push(<React.Fragment key={i}>{part}</React.Fragment>);
        }
    });
    return nodes;
}

// ============================================
// SHARED SECTIONS
// ============================================

interface SectionProps {
    dash: TopicDashboard;
    hl: boolean;
    openExternal: (url: string) => void;
}

const SentimentPill = ({ sentiment }: { sentiment: string }) => (
    <span className={`sentiment-pill ${sentiment.toLowerCase()}`}>
        {sentiment === 'Positive' ? '▲' : sentiment === 'Negative' ? '▼' : '●'} {sentiment}
    </span>
);

const TemplateBadge = ({ template }: { template: string }) => {
    const names: Record<string, string> = {
        pulse: 'Pulse Board', editorial: 'Editorial', timeline: 'Chronicle',
        spotlight: 'Spotlight', matrix: 'Matrix',
    };
    return <span className={`template-badge tb-${template}`}>{names[template] || template}</span>;
};

const StatTiles = ({ dash }: { dash: TopicDashboard }) => {
    if (!dash.content.stats?.length) return null;
    return (
        <div className="stat-tiles">
            {dash.content.stats.map((s, i) => (
                <div className="stat-tile" key={i} style={{ animationDelay: `${i * 0.06}s` }}>
                    <div className="stat-value">{s.value}</div>
                    <div className="stat-label">{s.label}</div>
                    {s.context && <div className="stat-context">{s.context}</div>}
                </div>
            ))}
        </div>
    );
};

const KeyPointItem = ({ point, hl }: { point: DashboardKeyPoint; hl: boolean }) => (
    <li className={`key-point ${point.is_sponsored ? 'sponsored' : ''}`}>
        {point.tag && <span className="point-tag">{point.tag}</span>}
        {point.is_sponsored && <span className="point-tag ad-tag">Ad</span>}
        <span>{richText(point.text, hl)}</span>
    </li>
);

const KeyPoints = ({ dash, hl, title = 'Key Points' }: { dash: TopicDashboard; hl: boolean; title?: string }) => {
    if (!dash.content.key_points?.length) return null;
    return (
        <section className="dash-section">
            <h3 className="section-title">{title}</h3>
            <ul className="key-points">
                {dash.content.key_points.map((p, i) => <KeyPointItem key={i} point={p} hl={hl} />)}
            </ul>
        </section>
    );
};

const TimelineSection = ({ dash, hl }: { dash: TopicDashboard; hl: boolean }) => {
    if (!dash.content.timeline?.length) return null;
    return (
        <section className="dash-section">
            <h3 className="section-title">Timeline</h3>
            <div className="timeline-track">
                {dash.content.timeline.map((t, i) => (
                    <div className="timeline-item" key={i} style={{ animationDelay: `${i * 0.08}s` }}>
                        <div className="timeline-marker" />
                        <div className="timeline-body">
                            <div className="timeline-label">{t.label}</div>
                            <div className="timeline-text">{richText(t.text, hl)}</div>
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
};

const Quotes = ({ dash, hl }: { dash: TopicDashboard; hl: boolean }) => {
    if (!dash.content.quotes?.length) return null;
    return (
        <section className="dash-section">
            {dash.content.quotes.map((q, i) => (
                <blockquote className="pull-quote" key={i}>
                    <p>“{richText(q.text, hl)}”</p>
                    {q.attribution && <cite>— {q.attribution}</cite>}
                </blockquote>
            ))}
        </section>
    );
};

const ActionItems = ({ dash, hl }: { dash: TopicDashboard; hl: boolean }) => {
    if (!dash.content.action_items?.length) return null;
    return (
        <section className="dash-section action-panel">
            <h3 className="section-title">Action Items</h3>
            <ul className="action-list">
                {dash.content.action_items.map((a, i) => (
                    <li key={i}><span className="action-check">✓</span>{richText(a, hl)}</li>
                ))}
            </ul>
        </section>
    );
};

const Glossary = ({ dash }: { dash: TopicDashboard }) => {
    if (!dash.content.glossary?.length) return null;
    return (
        <section className="dash-section">
            <h3 className="section-title">Glossary</h3>
            <dl className="glossary">
                {dash.content.glossary.map((g, i) => (
                    <div className="glossary-item" key={i}>
                        <dt>{g.term}</dt>
                        <dd>{g.definition}</dd>
                    </div>
                ))}
            </dl>
        </section>
    );
};

const WebContext = ({ dash, hl, openExternal }: SectionProps) => {
    if (!dash.content.web_context?.length) return null;
    return (
        <section className="dash-section">
            <h3 className="section-title">From Around the Web</h3>
            <div className="web-context-grid">
                {dash.content.web_context.map((w, i) => {
                    const src = w.source_index != null ? dash.sources[w.source_index - 1] : undefined;
                    return (
                        <div className="web-context-card" key={i}>
                            <h4>{w.title}</h4>
                            <p>{richText(w.text, hl)}</p>
                            {src && (
                                <button className="source-link" onClick={() => openExternal(src.url)}>
                                    ↗ {new URL(src.url).hostname.replace('www.', '')}
                                </button>
                            )}
                        </div>
                    );
                })}
            </div>
        </section>
    );
};

const FunFact = ({ dash, hl }: { dash: TopicDashboard; hl: boolean }) => {
    if (!dash.content.fun_fact) return null;
    return (
        <div className="fun-fact">
            <span className="fun-fact-icon">💡</span>
            <span>{richText(dash.content.fun_fact, hl)}</span>
        </div>
    );
};

const ImageStrip = ({ images, openExternal, hero = false }: { images: DashboardImage[]; openExternal: (url: string) => void; hero?: boolean }) => {
    if (!images?.length) return null;
    const list = hero ? images.slice(1) : images;
    if (!list.length) return null;
    return (
        <div className="image-strip">
            {list.map((img, i) => (
                <figure className="dash-image" key={i} onClick={() => img.sourceUrl && openExternal(img.sourceUrl)}>
                    <img src={img.url} alt={img.title || 'related'} loading="lazy"
                        onError={(e) => { (e.currentTarget.closest('figure') as HTMLElement).style.display = 'none'; }} />
                    {img.title && <figcaption>{img.title}</figcaption>}
                </figure>
            ))}
        </div>
    );
};

const SourcesFooter = ({ dash, openExternal }: { dash: TopicDashboard; openExternal: (url: string) => void }) => (
    <footer className="dash-footer">
        {dash.sources.length > 0 && (
            <div className="sources-block">
                <h4>Sources</h4>
                <div className="source-chips">
                    {dash.sources.map((s: SearchSource, i) => (
                        <button className="source-chip" key={i} title={s.title} onClick={() => openExternal(s.url)}>
                            <span className="source-num">{i + 1}</span>
                            {(() => { try { return new URL(s.url).hostname.replace('www.', ''); } catch { return s.title; } })()}
                        </button>
                    ))}
                </div>
            </div>
        )}
        <div className="sources-block">
            <h4>From Your Inbox</h4>
            <div className="email-refs">
                {dash.emails.map((e, i) => (
                    <div className="email-ref" key={i}>
                        <span className="email-ref-subject">{e.subject}</span>
                        <span className="email-ref-sender">{e.senderName}</span>
                    </div>
                ))}
            </div>
        </div>
    </footer>
);

// ============================================
// TEMPLATE LAYOUTS
// ============================================

const DashHero = ({ dash, hl }: { dash: TopicDashboard; hl: boolean }) => (
    <div className="dash-hero">
        <div className="dash-hero-meta">
            <span className="dash-icon">{dash.icon}</span>
            <span className="dash-category">{dash.category}</span>
            <TemplateBadge template={dash.template} />
            <SentimentPill sentiment={dash.content.sentiment} />
        </div>
        <h1 className="dash-headline">{richText(dash.content.headline, hl)}</h1>
        <p className="dash-overview">{richText(dash.content.overview, hl)}</p>
    </div>
);

const PulseLayout = (p: SectionProps) => (
    <>
        <DashHero dash={p.dash} hl={p.hl} />
        <StatTiles dash={p.dash} />
        <div className="dash-columns">
            <div className="dash-col-main">
                <KeyPoints dash={p.dash} hl={p.hl} />
                <ActionItems dash={p.dash} hl={p.hl} />
            </div>
            <div className="dash-col-side">
                <WebContext {...p} />
                <ImageStrip images={p.dash.images} openExternal={p.openExternal} />
            </div>
        </div>
    </>
);

const EditorialLayout = (p: SectionProps) => {
    const heroImg = p.dash.images[0];
    return (
        <>
            {heroImg && (
                <div className="editorial-hero-img" onClick={() => heroImg.sourceUrl && p.openExternal(heroImg.sourceUrl)}>
                    <img src={heroImg.url} alt={heroImg.title || ''}
                        onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = 'none'; }} />
                </div>
            )}
            <DashHero dash={p.dash} hl={p.hl} />
            <Quotes dash={p.dash} hl={p.hl} />
            <div className="dash-columns">
                <div className="dash-col-main">
                    <KeyPoints dash={p.dash} hl={p.hl} title="The Story" />
                    <WebContext {...p} />
                </div>
                <div className="dash-col-side">
                    <Glossary dash={p.dash} />
                    <StatTiles dash={p.dash} />
                </div>
            </div>
        </>
    );
};

const TimelineLayout = (p: SectionProps) => (
    <>
        <DashHero dash={p.dash} hl={p.hl} />
        <div className="dash-columns">
            <div className="dash-col-main">
                <TimelineSection dash={p.dash} hl={p.hl} />
            </div>
            <div className="dash-col-side">
                <StatTiles dash={p.dash} />
                <KeyPoints dash={p.dash} hl={p.hl} title="Highlights" />
                <ImageStrip images={p.dash.images} openExternal={p.openExternal} />
            </div>
        </div>
        <WebContext {...p} />
    </>
);

const SpotlightLayout = (p: SectionProps) => {
    const heroImg = p.dash.images[0];
    return (
        <>
            <div className={`spotlight-hero ${heroImg ? 'has-img' : ''}`}>
                {heroImg && <img className="spotlight-bg" src={heroImg.url} alt=""
                    onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
                <div className="spotlight-hero-content">
                    <DashHero dash={p.dash} hl={p.hl} />
                </div>
            </div>
            <FunFact dash={p.dash} hl={p.hl} />
            <div className="dash-columns">
                <div className="dash-col-main">
                    <KeyPoints dash={p.dash} hl={p.hl} />
                    <WebContext {...p} />
                </div>
                <div className="dash-col-side">
                    <ActionItems dash={p.dash} hl={p.hl} />
                    <ImageStrip images={p.dash.images} openExternal={p.openExternal} hero />
                </div>
            </div>
        </>
    );
};

const MatrixLayout = (p: SectionProps) => (
    <>
        <DashHero dash={p.dash} hl={p.hl} />
        <StatTiles dash={p.dash} />
        {p.dash.content.key_points?.length > 0 && (
            <section className="dash-section">
                <h3 className="section-title">The Matrix</h3>
                <div className="matrix-grid">
                    {p.dash.content.key_points.map((pt, i) => (
                        <div className={`matrix-cell ${pt.is_sponsored ? 'sponsored' : ''}`} key={i}
                            style={{ animationDelay: `${i * 0.04}s` }}>
                            {(pt.tag || pt.is_sponsored) && (
                                <span className={`point-tag ${pt.is_sponsored ? 'ad-tag' : ''}`}>
                                    {pt.is_sponsored ? 'Ad' : pt.tag}
                                </span>
                            )}
                            <p>{richText(pt.text, p.hl)}</p>
                        </div>
                    ))}
                </div>
            </section>
        )}
        <div className="dash-columns">
            <div className="dash-col-main"><Glossary dash={p.dash} /></div>
            <div className="dash-col-side"><ImageStrip images={p.dash.images} openExternal={p.openExternal} /></div>
        </div>
    </>
);

// ============================================
// FULL DASHBOARD VIEW
// ============================================

interface DashboardDetailProps {
    dash: TopicDashboard;
    highlightsEnabled: boolean;
    openExternal: (url: string) => void;
    onBack: () => void;
}

export const DashboardDetail = ({ dash, highlightsEnabled, openExternal, onBack }: DashboardDetailProps) => {
    const p: SectionProps = { dash, hl: highlightsEnabled, openExternal };
    return (
        <div className={`dashboard-detail dash--${dash.template} reader-surface`}>
            <button className="back-btn" onClick={onBack}>← All Topics</button>
            {dash.template === 'pulse' && <PulseLayout {...p} />}
            {dash.template === 'editorial' && <EditorialLayout {...p} />}
            {dash.template === 'timeline' && <TimelineLayout {...p} />}
            {dash.template === 'spotlight' && <SpotlightLayout {...p} />}
            {dash.template === 'matrix' && <MatrixLayout {...p} />}
            <SourcesFooter dash={dash} openExternal={openExternal} />
        </div>
    );
};

// ============================================
// GRID CARD
// ============================================

export const DashboardCard = ({ dash, index, onClick }: { dash: TopicDashboard; index: number; onClick: () => void }) => {
    const img = dash.images[0];
    return (
        <article className="topic-card" style={{ animationDelay: `${index * 0.07}s` }} onClick={onClick}>
            {img && (
                <div className="topic-card-img">
                    <img src={img.url} alt="" loading="lazy"
                        onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = 'none'; }} />
                </div>
            )}
            <div className="topic-card-body">
                <div className="topic-card-meta">
                    <span className="dash-icon">{dash.icon}</span>
                    <span className="dash-category">{dash.category}</span>
                    <TemplateBadge template={dash.template} />
                    <SentimentPill sentiment={dash.content.sentiment} />
                </div>
                <h2 className="topic-card-headline">{dash.content.headline.replace(/==/g, '')}</h2>
                <p className="topic-card-overview">{dash.content.overview.replace(/==|\*\*/g, '')}</p>
                {dash.content.stats?.length > 0 && (
                    <div className="topic-card-stats">
                        {dash.content.stats.slice(0, 3).map((s, i) => (
                            <div key={i} className="mini-stat">
                                <span className="mini-stat-value">{s.value}</span>
                                <span className="mini-stat-label">{s.label}</span>
                            </div>
                        ))}
                    </div>
                )}
                <div className="topic-card-foot">
                    <span>{dash.emails.length} email{dash.emails.length !== 1 ? 's' : ''}</span>
                    <span>{dash.sources.length} source{dash.sources.length !== 1 ? 's' : ''}</span>
                    <span className="open-hint">Open dashboard →</span>
                </div>
            </div>
        </article>
    );
};
