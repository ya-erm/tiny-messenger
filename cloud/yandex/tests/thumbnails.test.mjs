import test from 'node:test';import assert from'node:assert/strict';import{completeThumbnail,thumbnailRequestedSize,THUMBNAIL_SUFFIX}from'../shared/attachment-thumbnail.mjs';
test('thumbnail is optional, bounded, immutable and checks signed upload metadata',async()=>{
 assert.equal(thumbnailRequestedSize(undefined,'image/png'),null);assert.equal(thumbnailRequestedSize(100,'image/png'),100);assert.throws(()=>thumbnailRequestedSize(102401,'image/png'));assert.throws(()=>thumbnailRequestedSize(10,'application/pdf'));
 const objects=new Map(),storage={async headAttachment(id,key){return objects.get(key)||null;},async freezeAttachment(id,from,to,etag,type){assert.equal(etag,objects.get(from).ETag);objects.set(to,{ContentLength:100,ContentType:type,Metadata:{'upload-id':id,'source-etag':etag.replaceAll('"','')},ETag:'"final"'});}};
 const missing=await completeThumbnail('id','staging','final',100,storage);assert.equal(missing.thumbnailKey,null);
 objects.set('staging'+THUMBNAIL_SUFFIX,{ContentLength:100,ContentType:'image/webp',ETag:'"source"',Metadata:{'upload-id':'id-thumbnail'}});
 const done=await completeThumbnail('id','staging','final',100,storage);assert.equal(done.thumbnailKey,'final'+THUMBNAIL_SUFFIX);assert.deepEqual(await completeThumbnail('id','staging','final',100,storage),done);
 objects.delete('final'+THUMBNAIL_SUFFIX);objects.get('staging'+THUMBNAIL_SUFFIX).Metadata['upload-id']='other-user';await assert.rejects(completeThumbnail('id','staging','final',100,storage),error=>error.status===422);
});
