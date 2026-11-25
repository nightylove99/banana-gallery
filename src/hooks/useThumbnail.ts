import { useEffect, useRef, useState } from 'react'
import type { GalleryImage } from '../types'
import { getThumbnailLoader, type ThumbnailLease } from '../lib/thumbnail-loader'

export function useThumbnail(image: GalleryImage | undefined, options: { preview?: boolean; priority?: 'high' | 'low' | 'auto'; retry?: number; enabled?: boolean } = {}) {
  const loader=getThumbnailLoader()
  const filename=image?.filename, version=image?.thumbnailVersion
  const size=options.preview ? 'preview' : 'standard', priority=options.priority==='low' ? 'background' : 'foreground'
  const retry=options.retry || 0, enabled=options.enabled!==false
  const key=JSON.stringify([filename,version])
  const lease=useRef<ThumbnailLease | null>(null)
  const latest=useRef<Partial<Record<'preview' | 'standard', symbol>>>({})
  const requests=useRef(new Set<AbortController>())
  const [state,setState]=useState<{key:string;src?:string;size?:string;error?:string}>({key:''})
  useEffect(()=>{
    if(!loader || !filename || !version || !enabled)return
    const controller=new AbortController()
    const request=Symbol();latest.current[size]=request
    requests.current.add(controller)
    void loader.acquire({filename,version,size,priority},controller.signal).then(next=>{
      if(controller.signal.aborted || latest.current[size]!==request){next.release();return}
      if(lease.current?.size==='standard' && next.size==='preview'){next.release();return}
      const previous=lease.current;lease.current=next
      setState({key,src:next.url,size:next.size});previous?.release()
    },error=>{
      if(!controller.signal.aborted && latest.current[size]===request && !(size==='preview' && lease.current?.size==='standard'))setState({key,src:lease.current?.url,size:lease.current?.size,error:error instanceof Error ? error.message : '缩略图加载失败'})
    }).finally(()=>requests.current.delete(controller))
    // Visible previews may finish during an upgrade; resource cleanup cancels obsolete work.
  },[loader,filename,version,size,priority,retry,key,enabled])
  useEffect(()=>{
    const controllers=requests.current
    return ()=>{for(const controller of controllers)controller.abort();controllers.clear();lease.current?.release();lease.current=null}
  },[loader,filename,version,enabled])
  if(!filename)return {src:undefined,error:undefined,ready:false,size:undefined}
  if(!loader || !version)return {src:`/api/assets/images/${filename}?thumbnail=true${retry ? `&retry=${retry}` : ''}`,error:undefined,ready:false,size:'standard'}
  return {src:state.key===key ? state.src : undefined,error:state.key===key ? state.error : undefined,ready:state.key===key && !!state.src,size:state.key===key ? state.size : undefined}
}
