import { BookUser, Bot, MessageCircleMore, Moon, Settings, SunMedium } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AppCapabilities } from '../lib/api';

export type CrmWorkspace = 'whatsapp' | 'contacts' | 'leadops' | 'system';

type Props = {
  active: CrmWorkspace;
  capabilities: AppCapabilities;
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
};

const ITEMS: NavItem[] = [
  { id: 'whatsapp', label: 'WhatsApp', shortLabel: 'Chats', icon: MessageCircleMore },
  { id: 'contacts', label: 'Contacts', shortLabel: 'Contacts', icon: BookUser },
  { id: 'leadops', label: 'Lead intelligence', shortLabel: 'LeadOps', icon: Bot },
  { id: 'system', label: 'System', shortLabel: 'System', icon: Settings },
];

export function CrmNavigation({ active, capabilities, theme, unreadCount, onNavigate, onToggleTheme }: Props) {
  const visible = ITEMS.filter((item) => (
    item.id === 'whatsapp'
    || (item.id === 'contacts' && capabilities.contacts)
    || (item.id === 'leadops' && capabilities.aiExtraction)
    || (item.id === 'system' && capabilities.system)
  ));
  return (
    <aside className="crm-navigation" aria-label="Primary navigation">
      <div className="crm-navigation__brand" title="Jay Jalaram Enterprise"><span>J</span></div>
      <nav>
        {visible.map((item) => (
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
