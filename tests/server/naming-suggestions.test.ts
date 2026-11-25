import {expect,it} from 'vitest'
import {localNamingSuggestion} from '../../src/lib/naming-suggestions'
it('extracts preview suggestions, preserves handwritten titles and never invents a model-generated answer',()=>{
 const suggestion=localNamingSuggestion({title:'我的标题',prompt:'# 人像摄影\n电影光线，黄昏森林',tags:['gemini-web']})
 expect(suggestion.title).toBe('我的标题');expect(suggestion.existingTitle).toBe(true);expect(suggestion.tags).toContain('人像');expect(suggestion.tags).not.toContain('gemini-web')
 expect(localNamingSuggestion({prompt:'  # 角色练习\nA portrait in a forest',tags:[]}).title).toBe('角色练习')
})
