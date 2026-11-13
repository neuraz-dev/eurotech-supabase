import HistorySection from './HistorySection'
import type { AlertPage, AlertOptions, AlertRule } from '@/lib/price-alerts'
export default function AlertasLayout(props:{initialPage:AlertPage;options:AlertOptions;rules:AlertRule[]}){
  return <HistorySection {...props}/>
}
