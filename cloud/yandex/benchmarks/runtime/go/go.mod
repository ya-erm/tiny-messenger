module runtimebench

go 1.23

require (
 github.com/ydb-platform/ydb-go-sdk/v3 v3.126.5
 github.com/ydb-platform/ydb-go-yc-metadata v0.6.2
)

// Keep the split genproto modules compatible with the managed Go runtime.
replace google.golang.org/genproto => google.golang.org/genproto v0.0.0-20241015192408-796eee8c2d53
replace google.golang.org/genproto/googleapis/rpc => google.golang.org/genproto/googleapis/rpc v0.0.0-20241015192408-796eee8c2d53
