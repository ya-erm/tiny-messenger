import {tasksOrigin,integrationEnabled} from "@/lib/tasks-integration";
import {TasksEmbed} from "@/components/tasks-integration";
export const dynamic="force-dynamic";
export default function Page(){return integrationEnabled?<TasksEmbed tasksOrigin={tasksOrigin}/>:<main><h1>Интеграция не настроена</h1></main>;}
