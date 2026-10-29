-- Aluno aparecendo duas e tres vezes na fila.
--
-- Amanda: "alunos sem acionamentos quadruplicados na fila".
--
-- O QUE ACONTECEU. Cada aluno tem o caso REAL (carga de 29/06: nome, cpf,
-- caso_codigo, matricula) e uma COPIA VAZIA criada depois -- 444 em 15/07, mais
-- 13 em outras datas. A copia so tem aluno_id e saldo: nome, cpf, codigo e
-- matricula todos nulos. Sao 457 copias, R$ 1.243.858,06 de saldo contado em
-- dobro na carteira.
--
-- POR QUE PARECIA "SEM ACIONAMENTO". O operador acionava e o registro ia para a
-- COPIA. O caso real ficava com a data velha -- e aparecia na fila como se
-- nunca tivesse sido tocado, ao lado da copia.
--
-- NAO DA PARA SIMPLESMENTE APAGAR A COPIA: em 204 casos so ela tem o operador,
-- e em 298 o acionamento dela e mais recente. E fusao, nao exclusao.

create table if not exists public._backup_caso_fantasma_20260828 as
with fant as (
  select c.id, c.aluno_id, c.operador_email, c.operador_nome,
         c.data_ultimo_acionamento, c.status_acionamento, c.encerrado_operacional
  from public.casos c
  where not coalesce(c.encerrado_operacional,false) and c.aluno_id is not null
    and c.nome is null and c.cpf_limpo is null and c.caso_codigo is null
    and exists (select 1 from public.casos o
                 where o.aluno_id = c.aluno_id and o.id <> c.id and o.nome is not null)
)
select f.id as caso_fantasma_id, f.aluno_id,
       f.operador_email as fantasma_operador, f.data_ultimo_acionamento as fantasma_acionamento,
       o.id as caso_real_id, o.nome as caso_real_nome,
       o.operador_email as real_operador_antes, o.data_ultimo_acionamento as real_acionamento_antes,
       now() as fundido_em
  from fant f
  join lateral (
    select c2.id, c2.nome, c2.operador_email, c2.data_ultimo_acionamento
      from public.casos c2
     where c2.aluno_id = f.aluno_id and c2.id <> f.id and c2.nome is not null
     order by c2.created_at limit 1
  ) o on true;

update public.casos c
   set operador_email = coalesce(c.operador_email, b.fantasma_operador),
       data_ultimo_acionamento = greatest(
         coalesce(c.data_ultimo_acionamento, '1900-01-01'::date),
         coalesce(b.fantasma_acionamento, '1900-01-01'::date))
  from public._backup_caso_fantasma_20260828 b
 where c.id = b.caso_real_id;

update public.casos c
   set data_ultimo_acionamento = null
  from public._backup_caso_fantasma_20260828 b
 where c.id = b.caso_real_id
   and c.data_ultimo_acionamento = '1900-01-01'::date;

update public.casos c
   set encerrado_operacional = true,
       caso_atualizado_por = 'sistema_fusao_caso_fantasma',
       caso_atualizado_em = now()
  from public._backup_caso_fantasma_20260828 b
 where c.id = b.caso_fantasma_id;
