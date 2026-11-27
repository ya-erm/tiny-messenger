package main

const replicationFeed = "@tm-replication-v1"

func appendReplication(tx Tx, key string, event M) {
	if tx.Get("replication-index", key) != nil {
		return
	}
	seq := tx.NextSequence()
	tx.AddFeed(replicationFeed, seq, event)
	tx.Put("replication-index", key, M{"sequence": seq})
}
