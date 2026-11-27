package main

import (
	"context"
	"sort"
	"strings"
)

func (sv *Service) modifyGroup(ctx context.Context, actor M, id string, body M, action string) M {
	return m(sv.rowsTransaction(ctx, false, func(r *Rows) any {
		if action == "create" {
			ids := uniq(append([]string{s(actor, "id")}, stringsOf(list(body, "memberIds"))...))
			name := strings.TrimSpace(s(body, "name"))
			valid := name != "" && runeCount(name) <= 40 && len(ids) >= 2 && len(ids) <= 50
			for _, uid := range ids {
				valid = valid && validUUID(uid)
			}
			if !valid {
				fail(422, "invalid_group", "Некорректная группа")
			}
			for _, uid := range ids {
				if r.Get("users", uid) == nil {
					fail(404, "user_not_found", "Участник не найден")
				}
			}
			if !validUUID(id) {
				id = uuid()
			}
			if existing := r.row("Group", id); existing != nil {
				current := r.group(id, s(actor, "id"))
				members := []string{}
				for _, v := range list(current, "members") {
					members = append(members, s(m(v), "id"))
				}
				sort.Strings(members)
				sorted := append([]string{}, ids...)
				sort.Strings(sorted)
				if s(current, "ownerId") != s(actor, "id") || s(current, "name") != name || strings.Join(members, ",") != strings.Join(sorted, ",") {
					fail(409, "group_id_conflict", "Идентификатор уже использован")
				}
				return M{"group": current}
			}
			if r.state("Group", id) != nil {
				fail(409, "group_id_conflict", "Группа удалена")
			}
			at := now()
			r.put("Group", M{"id": id, "name": name, "ownerId": actor["id"], "createdAt": at, "updatedAt": at}, false, false)
			for _, uid := range ids {
				r.put("GroupMember", M{"groupId": id, "userId": uid}, false, false)
			}
		} else {
			current := r.group(id, s(actor, "id"))
			if action == "edit" {
				if s(current, "ownerId") != s(actor, "id") {
					fail(403, "not_group_owner", "Изменять группу может только владелец")
				}
				patch := M{"id": id, "updatedAt": now()}
				for _, key := range []string{"name", "avatarUrl", "avatarBackground"} {
					if own(body, key) {
						patch[key] = nullable(strings.TrimSpace(s(body, key)))
					}
				}
				if own(patch, "name") && (s(patch, "name") == "" || runeCount(s(patch, "name")) > 40) {
					fail(422, "invalid_name", "Некорректное название")
				}
				if truth(patch["avatarUrl"]) && (!(strings.HasPrefix(s(patch, "avatarUrl"), "http://") || strings.HasPrefix(s(patch, "avatarUrl"), "https://")) || utf16len(s(patch, "avatarUrl")) > 500) || truth(patch["avatarBackground"]) && !colorRE.MatchString(s(patch, "avatarBackground")) {
					fail(422, "invalid_avatar", "Некорректная аватарка")
				}
				r.put("Group", patch, false, true)
			} else {
				target := s(body, "userId")
				if action == "leave" {
					target = s(actor, "id")
				}
				if !validUUID(target) || r.Get("users", target) == nil {
					fail(422, "invalid_user_id", "Некорректный участник")
				}
				if action == "remove" && (s(current, "ownerId") != s(actor, "id") || target == s(actor, "id")) {
					fail(403, "not_group_owner", "Исключать участника может владелец")
				}
				has := false
				remaining := []M{}
				for _, v := range list(current, "members") {
					u := m(v)
					if s(u, "id") == target {
						has = true
					} else {
						remaining = append(remaining, u)
					}
				}
				if action == "add" {
					if !has && len(list(current, "members")) >= 50 {
						fail(422, "too_many_members", "Слишком много участников")
					}
					if !has {
						r.put("GroupMember", M{"groupId": id, "userId": target}, false, false)
					}
				} else {
					if !has {
						fail(404, "member_not_found", "Участник не найден")
					}
					r.put("GroupMember", M{"groupId": id, "userId": target}, true, false)
					if len(remaining) == 0 {
						for _, index := range r.Views("@group:"+id, 10000) {
							message := r.row("GroupMessage", s(index, "id"))
							if message != nil {
								r.detachFiles(s(message, "id"))
								r.put("GroupMessage", message, true, false)
							}
						}
						r.put("Group", r.row("Group", id), true, false)
						return M{"left": true, "deleted": true}
					}
					if s(current, "ownerId") == target {
						r.put("Group", M{"id": id, "ownerId": remaining[0]["id"], "updatedAt": now()}, false, true)
					}
				}
			}
		}
		if action == "leave" {
			return M{"left": true, "deleted": false}
		}
		return M{"group": r.group(id, s(actor, "id"))}
	}))
}
