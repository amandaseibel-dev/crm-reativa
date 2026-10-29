-- Sobra da fusao anterior: 3 alunos com o caso TRIPLICADO, nao duplicado.
-- A regra anterior so pegava pares (having count(*) = 2). Mesmo nome, mesmo
-- saldo e mesmo CPF normalizado nos tres. Fica o registro mais completo --
-- prioridade para quem ja tem operador, depois matricula, depois CPF de 11
-- digitos -- herdando o que falta.

create table if not exists public._backup_caso_dup_trio_20260828 as
with grupos as (
  select c.aluno_id,
         (array_agg(c.id order by
            (case when c.operador_email is not null then 0 else 1 end),
            (case when c.matricula is not null then 0 else 1 end),
            length(coalesce(c.cpf_limpo,'')) desc,
            c.created_at))[1] as fica,
         array_agg(c.id order by
            (case when c.operador_email is not null then 0 else 1 end),
            (case when c.matricula is not null then 0 else 1 end),
            length(coalesce(c.cpf_limpo,'')) desc,
            c.created_at) as todos
    from public.casos c
   where not coalesce(c.encerrado_operacional,false) and c.aluno_id is not null
   group by 1
  having count(*) > 1
     and count(distinct lpad(coalesce(c.cpf_limpo,''),11,'0')) = 1
     and count(distinct c.saldo_total) = 1
)
select g.aluno_id, g.fica, t.id as sai,
       f.matricula as matricula_do_que_fica, t.matricula as matricula_do_outro,
       f.operador_email as operador_do_que_fica, t.operador_email as operador_do_outro,
       t.data_ultimo_acionamento as acionamento_do_outro,
       now() as fundido_em
  from grupos g
  join public.casos f on f.id = g.fica
  join public.casos t on t.id = any(g.todos) and t.id <> g.fica;

update public.casos c
   set matricula = coalesce(c.matricula, b.matricula_do_outro),
       operador_email = coalesce(c.operador_email, b.operador_do_outro),
       data_ultimo_acionamento = nullif(greatest(
         coalesce(c.data_ultimo_acionamento, '1900-01-01'::date),
         coalesce(b.acionamento_do_outro, '1900-01-01'::date)), '1900-01-01'::date)
  from public._backup_caso_dup_trio_20260828 b
 where c.id = b.fica;

update public.casos c
   set encerrado_operacional = true,
       caso_atualizado_por = 'sistema_fusao_trio',
       caso_atualizado_em = now()
  from public._backup_caso_dup_trio_20260828 b
 where c.id = b.sai;
