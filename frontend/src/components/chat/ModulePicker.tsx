import type { Session } from '../../types/session'
import { collectSelectableModules } from '../../utils/modules'

export function ModulePicker({
  onSelectModule,
  selectedModuleId,
  session,
}: {
  onSelectModule: (id: string | null) => void
  selectedModuleId: string | null
  session: Session | null
}) {
  const modules = collectSelectableModules(session)
  return (
    <div className={`module-picker${modules.length ? '' : ' is-empty'}`}>
      <div className="module-picker-header">
        <span>选择模块</span>
        <strong>{selectedModuleId || (modules.length ? '全部' : '暂无模块')}</strong>
      </div>
      <div className="module-picker-list">
        {modules.length ? (
          <>
            <button
              className={`module-picker-option${!selectedModuleId ? ' is-selected' : ''}`}
              onClick={() => onSelectModule(null)}
              type="button"
            >
              全部
            </button>
            {modules.map((module, index) => (
              <button
                className={`module-picker-option${module.id === selectedModuleId ? ' is-selected' : ''}`}
                data-module-id={module.id}
                key={module.id}
                onClick={() => onSelectModule(module.id)}
                type="button"
              >
                {index + 1}. {module.id}
              </button>
            ))}
          </>
        ) : (
          <span className="chat-drawer-meta">生成完成后可选择模块</span>
        )}
      </div>
    </div>
  )
}
