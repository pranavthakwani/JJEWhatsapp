import { BookUser, Bot, MessageCircleMore, Moon, Settings, SunMedium } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type CrmWorkspace = 'whatsapp' | 'contacts' | 'leadops' | 'system';

type Props = {
  active: CrmWorkspace;
  aiEnabled: boolean;
  theme: 'dark' | 'light';
  unreadCount: number;
  onNavigate: (workspace: CrmWorkspace) => void;
  onToggleTheme: () => void;
};

type NavItem = {
  id: CrmWorkspace;
  label: string;
  shortLabel: string;
  icon: LucideIcon;
  aiOnly?: boolean;
};

const ITEMS: NavItem[] = [
  { id: 'whatsapp', label: 'WhatsApp', shortLabel: 'Chats', icon: MessageCircleMore },
  { id: 'contacts', label: 'Contacts', shortLabel: 'Contacts', icon: BookUser },
  { id: 'leadops', label: 'Lead intelligence', shortLabel: 'LeadOps', icon: Bot, aiOnly: true },
  { id: 'system', label: 'System', shortLabel: 'System', icon: Settings },
];

export function CrmNavigation({ active, aiEnabled, theme, unreadCount, onNavigate, onToggleTheme }: Props) {
  return (
    <aside className="crm-navigation" aria-label="Primary navigation">
      <div className="crm-navigation__brand" title="Jay Jalaram Enterprise"><span>J</span></div>
      <nav>
        {ITEMS.filter((item) => !item.aiOnly || aiEnabled).map((item) => (
          <button
            key={item.id}
            type="button"
            className={active === item.id ? 'is-active' : ''}
            onClick={() => onNavigate(item.id)}
            aria-current={active === item.id ? 'page' : undefined}
            title={item.label}
          >
            <span className="crm-navigation__icon"><item.icon size={20} />{item.id === 'whatsapp' && unreadCount > 0 && <i>{unreadCount > 99 ? '99+' : unreadCount}</i>}</span>
            <small>{item.shortLabel}</small>
          </button>
        ))}
      </nav>
      <button type="button" className="crm-navigation__theme" onClick={onToggleTheme} title="Toggle theme">
        {theme === 'dark' ? <SunMedium size={20} /> : <Moon size={20} />}
        <small>Theme</small>
      </button>
    </aside>
  );
}
