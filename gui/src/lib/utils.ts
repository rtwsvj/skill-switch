// shadcn/ui 推荐的 cn helper —— 结合 clsx(条件类)和 tailwind-merge(消除冲突 Tailwind class)。
// 后续各屏 Agent 引入组件时统一从这里导入 cn。
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
