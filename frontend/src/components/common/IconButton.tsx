import type { ButtonHTMLAttributes, ReactNode } from 'react'

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  danger?: boolean
  children: ReactNode
}

export function IconButton({ children, className = '', danger = false, ...props }: IconButtonProps) {
  return (
    <button className={`icon-btn${danger ? ' icon-btn-danger' : ''}${className ? ` ${className}` : ''}`} type="button" {...props}>
      {children}
    </button>
  )
}
