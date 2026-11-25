import {ApiHttpError} from '@/api'
import type {PersonalPreferences} from '@/types'
export async function preferenceRequest<T>(url='/preferences',method='GET',body?:unknown):Promise<T>{const response=await fetch('/api'+url,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});const data=await response.json();if(!response.ok)throw new ApiHttpError(response.status,data.error||'读取设置失败');return data}
export const fetchPreferences=()=>preferenceRequest<PersonalPreferences>()
