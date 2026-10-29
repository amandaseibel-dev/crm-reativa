-- Segunda causa da duplicidade na fila: CPF sem os zeros a esquerda.
--
-- Depois de fundir os 457 casos-fantasma, sobraram 53 alunos ainda repetidos.
-- Sao o MESMO caso duas vezes, da mesma carga de 29/06, diferindo so na
-- formatacao do CPF: "00892155086" e "892155086". Conferido: nos 53, o CPF
-- normalizado (lpad 11) e IGUAL e o saldo e IGUAL -- nao ha um unico par que
-- seja de pessoas diferentes.

create table if not exists public._backup_caso_dup_cpf_20260828 as
with pares as (
  select c.aluno_id,
         (array_agg(c.id order by length(coalesce(c.cpf_limpo,'')) desc, c.created_at))[1] as fica,
         (array_agg(c.id order by length(coalesce(c.cpf_limpo,'')) desc, c.created_at))[2] as sai
    from public.casos c
   where not coalesce(c.encerrado_operacional,false) and c.aluno_id is not null
   group by 1 having count(*) = 2
     and count(distinct lpad(coalesce(c.cpf_limpo,''),11,'0')) = 1
     and count(distinct c.saldo_total) = 1
)
select p.aluno_id, p.fica, p.sai,
       f.cpf_limpo as cpf_que_fica, s.cpf_limpo as cpf_que_sai,
       f.matricula as matricula_antes, s.matricula as matricula_do_outro,
       f.operador_email as operador_antes, s.operador_email as operador_do_outro,
       f.data_ultimo_acionamento as acionamento_antes, s.data_ultimo_acionamento as acionamento_do_outro,
       now() as fundido_em
  from pares p
  join public.casos f on f.id = p.fica
  join public.casos s on s.id = p.sai;

update public.casos c
   set matricula = coalesce(c.matricula, b.matricula_do_outro),
       operador_email = coalesce(c.operador_email, b.operador_do_outro),
       data_ultimo_acionamento = nullif(greatest(
         coalesce(c.data_ultimo_acionamento, '1900-01-01'::date),
         coalesce(b.acionamento_do_outro, '1900-01-01'::date)), '1900-01-01'::date)
  from public._backup_caso_dup_cpf_20260828 b
 where c.id = b.fica;

update public.casos c
   set encerrado_operacional = true,
       caso_atualizado_por = 'sistema_fusao_cpf_sem_zero',
       caso_atualizado_em = now()
  from public._backup_caso_dup_cpf_20260828 b
 where c.id = b.sai;
