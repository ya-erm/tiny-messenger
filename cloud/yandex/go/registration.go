package main

import (
	"context"
	"crypto/rand"
	"math/big"
	"strings"
	"time"
)

func randomIndex(size int) int {
	v, err := rand.Int(rand.Reader, big.NewInt(int64(size)))
	if err != nil {
		panic(err)
	}
	return int(v.Int64())
}
func animalByName(name string) M {
	for _, values := range animalProfiles {
		for _, v := range a(values) {
			if s(m(v), "name") == name {
				return m(v)
			}
		}
	}
	return nil
}
func randomAnimal() M {
	names := a(animalProfiles[randomIndex(len(animalProfiles))])
	return m(names[randomIndex(len(names))])
}
func (sv *Service) register(ctx context.Context, body M, ip string) M {
	supplied := clean(body["name"])
	animal := animalByName(supplied)
	if supplied == "" {
		animal = randomAnimal()
	}
	name := supplied
	if name == "" {
		name = s(animal, "name")
	}
	nickname := strings.TrimSpace(s(body, "nickname"))
	if name == "" || runeCount(name) > 20 {
		fail(422, "invalid_name", "Имя должно быть не длиннее 20 символов")
	}
	if nickname != "" && !nicknameRE.MatchString(nickname) {
		fail(422, "invalid_nickname", "Ник: до 32 строчных латинских букв, цифр или символов _ . -")
	}
	stable := own(body, "clientRequestId") || own(body, "registrationToken")
	id, token := uuid(), randomToken()
	if stable {
		if !validUUID(body["clientRequestId"]) || !tokenRE.MatchString(s(body, "registrationToken")) {
			fail(422, "invalid_registration_request", "Некорректный идентификатор регистрации")
		}
		id, token = s(body, "clientRequestId"), s(body, "registrationToken")
	}
	tokenHash := sha(token)
	fingerprint := sha(encode(O{{"name", supplied}, {"nickname", nickname}, {"tokenHash", tokenHash}}))
	return m(sv.transaction(ctx, false, func(tx Tx) any {
		if stable {
			if receipt := tx.Get("registration-requests", id); receipt != nil {
				current := tx.Get("users", id)
				if s(receipt, "hash") != fingerprint || current == nil || s(current, "tokenHash") != tokenHash {
					fail(409, "registration_conflict", "ID регистрации уже использован")
				}
				return M{"user": publicUser(current), "token": token, "replayed": true}
			}
		}
		if tx.Get("users", id) != nil || tx.Get("tokens", tokenHash) != nil {
			fail(409, "registration_conflict", "Идентификатор регистрации уже использован")
		}
		registry := tx.Scan("users", 1001)
		if len(registry) >= 1000 {
			fail(503, "registry_capacity", "Достигнут лимит пользователей этого контура")
		}
		for _, u := range registry {
			if nickname != "" && s(u, "nickname") == nickname {
				fail(409, "nickname_taken", "Этот ник уже занят")
			}
		}
		minute := time.Now().Unix() / 60
		for _, v := range []struct {
			key   string
			limit int
		}{{"all", 60}, {"ip:" + sha(ip), 5}} {
			old := tx.Get("registration-rate", v.key)
			count := 0
			if int64(n(old["minute"])) == minute {
				count = int(n(old["count"]))
			}
			if count >= v.limit {
				fail(429, "registration_rate_limited", "Слишком много регистраций. Попробуйте через минуту.")
			}
			tx.Put("registration-rate", v.key, M{"minute": minute, "count": count + 1})
		}
		at := now()
		user := M{"id": id, "name": name, "tokenHash": tokenHash, "createdAt": at, "updatedAt": at}
		if nickname != "" {
			user["nickname"] = nickname
		}
		if s(animal, "avatarUrl") != "" {
			user["avatarUrl"] = animal["avatarUrl"]
		}
		tx.Put("users", id, user)
		tx.Put("tokens", tokenHash, M{"userId": id})
		tx.Put("user-state", id, M{"contacts": A{}, "groups": A{}, "groupMessages": A{}, "hiddenPeerIds": A{}, "readStates": A{}})
		if stable {
			tx.Put("registration-requests", id, M{"hash": fingerprint})
		}
		appendReplication(tx, "user:"+id, M{"type": "user", "user": user})
		return M{"user": publicUser(user), "token": token, "replayed": false}
	}))
}
func (sv *Service) contact(ctx context.Context, actor, body M, remove bool) M {
	identifier := clean(body["identifier"])
	id := clean(body["userId"])
	if id == "" && validUUID(identifier) {
		id = identifier
	}
	nickname := clean(body["nickname"])
	if nickname == "" && id == "" {
		nickname = strings.TrimPrefix(identifier, "@")
	}
	if id != "" && !validUUID(id) || id == "" && !nicknameRE.MatchString(nickname) {
		fail(422, "invalid_contact", "Укажите корректный UUID или ник контакта")
	}
	return m(sv.rowsTransaction(ctx, false, func(r *Rows) any {
		var target M
		if id != "" {
			target = r.Get("users", id)
		} else {
			for _, user := range r.Scan("users", 10001) {
				if s(user, "nickname") == nickname {
					target = user
					break
				}
			}
		}
		if target == nil {
			fail(404, "user_not_found", "Пользователь не найден")
		}
		if s(target, "id") == s(actor, "id") {
			fail(422, "self_contact", "Себя добавлять не нужно")
		}
		state := copyMap(r.Get("user-state", s(actor, "id")))
		contacts := A{}
		var old M
		for _, item := range list(state, "contacts") {
			if s(m(item), "userId") == s(target, "id") {
				old = m(item)
			} else {
				contacts = append(contacts, item)
			}
		}
		at := now()
		if remove && old == nil {
			fail(404, "contact_not_found", "Контакт не найден")
		}
		created := s(old, "createdAt")
		if created == "" {
			created = at
		}
		contact := M{"userId": target["id"], "user": publicUser(target), "createdAt": created, "updatedAt": at}
		if !remove {
			contacts = append(contacts, contact)
		}
		state["contacts"] = contacts
		r.Put("user-state", s(actor, "id"), state)
		if !remove {
			r.clearConversation(s(actor, "id"), s(target, "id"))
		}
		op := M{"id": uuid(), "ownerId": actor["id"], "userId": target["id"], "at": at, "createdAt": created, "deleted": remove}
		appendReplication(r, "contact:"+s(op, "id"), M{"type": "contact", "contact": op})
		r.AddFeed(s(actor, "id"), r.NextSequence(), M{"type": "snapshot.required"})
		if remove {
			return M{"deleted": true}
		}
		return M{"contact": contact}
	}))
}
