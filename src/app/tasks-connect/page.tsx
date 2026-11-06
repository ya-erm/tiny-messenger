import {tasksOrigin,integrationEnabled} from "@/lib/tasks-integration";
import {TasksConnect} from "@/components/tasks-integration";
export const dynamic="force-dynamic";
export default function Page(){return integrationEnabled?<TasksConnect tasksOrigin={tasksOrigin}/>:<main><h1>Интеграция не настроена</h1></main>;}
