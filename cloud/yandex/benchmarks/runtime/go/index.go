package main

import (
 "context"
 "crypto/rand"
 "crypto/sha256"
 "crypto/subtle"
 "encoding/hex"
 "encoding/json"
 "errors"
 "io"
 "os"
 "regexp"
 "sort"
 "strings"
 "sync"
 "sync/atomic"
 "time"

 "github.com/ydb-platform/ydb-go-sdk/v3"
 "github.com/ydb-platform/ydb-go-sdk/v3/query"
 yc "github.com/ydb-platform/ydb-go-yc-metadata"
)

type Event struct { Body string `json:"body"`; Headers map[string]string `json:"headers"` }
type Response struct { StatusCode int `json:"statusCode"`; Headers map[string]string `json:"headers"`; Body string `json:"body"` }
var calls atomic.Int64
var connectionMu sync.Mutex
var connection *ydb.Driver
var bootID = func() string { value:=make([]byte,16);_,_=rand.Read(value);return hex.EncodeToString(value) }()
var uuidPattern=regexp.MustCompile(`^[0-9a-f-]{36}$`)
func respond(status int, data any) Response { body,_:=json.Marshal(data);return Response{status,map[string]string{"content-type":"application/json","cache-control":"no-store"},string(body)} }
func getDatabase(ctx context.Context)(*ydb.Driver,error) {
 connectionMu.Lock();defer connectionMu.Unlock()
 if connection!=nil{return connection,nil}
 driver,err:=ydb.Open(ctx,os.Getenv("YDB_CONNECTION_STRING"),yc.WithCredentials(),yc.WithInternalCA())
 if err!=nil{return nil,err};connection=driver;return connection,nil
}
func readBodies(ctx context.Context, tx query.TxActor, sql string, user string)([]string,error) {
 result,err:=tx.Query(ctx,sql,query.WithParameters(ydb.ParamsBuilder().Param("$user").Text(user).Build()))
 if err!=nil{return nil,err};defer result.Close(ctx)
 var values []string
 for { set,err:=result.NextResultSet(ctx);if errors.Is(err,io.EOF){break};if err!=nil{return nil,err}
  for { row,err:=set.NextRow(ctx);if errors.Is(err,io.EOF){break};if err!=nil{return nil,err};var body string;if err=row.Scan(&body);err!=nil{return nil,err};values=append(values,body) }
 };return values,nil
}
func Handler(ctx context.Context,event Event)(Response,error) {
 started:=time.Now();first:=calls.Add(1)==1
 var supplied string;for name,value:=range event.Headers {if strings.EqualFold(name,"x-tm-bench-key"){supplied=value}}
 expected:=os.Getenv("TM_BENCH_SECRET");if expected==""||subtle.ConstantTimeCompare([]byte(supplied),[]byte(expected))!=1{return respond(403,map[string]any{"error":"forbidden"}),nil}
 var input struct{Mode string `json:"mode"`};if json.Unmarshal([]byte(event.Body),&input)!=nil||(input.Mode!="echo"&&input.Mode!="read"){return respond(422,map[string]any{"error":"invalid_mode"}),nil}
 output:=map[string]any{"runtime":"go","bootId":bootID,"firstCall":first,"mode":input.Mode,"userPresent":false,"count":0,"digest":nil,"connectMs":0,"readMs":0}
 if input.Mode=="read" {
  ctx,cancel:=context.WithTimeout(ctx,12*time.Second);defer cancel()
  user:=os.Getenv("TM_BENCH_USER_ID");if !uuidPattern.MatchString(user){return respond(503,map[string]any{"error":"invalid_dataset"}),nil}
  connectStart:=time.Now();db,err:=getDatabase(ctx);output["connectMs"]=float64(time.Since(connectStart).Microseconds())/1000
  var users,messages []string;readStart:=time.Now()
  if err==nil {err=db.Query().DoTx(ctx,func(ctx context.Context,tx query.TxActor) error {
   var e error;users,e=readBodies(ctx,tx,`DECLARE $user AS Utf8; SELECT body FROM tm_kv WHERE bucket = 'users'u AND key = $user;`,user);if e!=nil{return e}
   messages,e=readBodies(ctx,tx,`DECLARE $user AS Utf8; SELECT body FROM tm_views WHERE user_id = $user ORDER BY sent_at DESC, message_id DESC LIMIT 100;`,user);return e
  },query.WithTxSettings(query.TxSettings(query.WithSnapshotReadOnly())),query.WithIdempotent())}
  output["readMs"]=float64(time.Since(readStart).Microseconds())/1000
  if err!=nil{return respond(503,map[string]any{"error":"benchmark_read_failed","runtime":"go","bootId":bootID,"firstCall":first,"handlerMs":float64(time.Since(started).Microseconds())/1000}),nil}
  ids:=[]string{""};for index,body:=range append(users,messages...) {var item struct{ID string `json:"id"`};if json.Unmarshal([]byte(body),&item)!=nil{return respond(503,map[string]any{"error":"invalid_row"}),nil};if index<len(users){ids[0]=item.ID}else{ids=append(ids,item.ID)}}
  sort.Strings(ids);digest:=sha256.Sum256([]byte(strings.Join(ids,"\n")));output["digest"]=hex.EncodeToString(digest[:]);output["userPresent"]=len(users)>0;output["count"]=len(messages)
 }
 output["handlerMs"]=float64(time.Since(started).Microseconds())/1000
 return respond(200,output),nil
}
