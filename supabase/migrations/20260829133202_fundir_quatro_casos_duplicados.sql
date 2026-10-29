-- Os 4 casos duplicados que sobraram da limpeza de 28/08.
--
-- Amanda: "pode fundir, que um aluno pode ter dois cursos". Dois cursos explicam
-- os dois casos e nao mudam a regra: a ficha do aluno e unica, entao as duas
-- dividas vao para UM caso (premissa 8).
--
-- POR QUE ESCAPARAM. Sao anteriores a trava `trg_caso_nao_duplica_aluno` (29/06
-- e 15/07; a trava e de 28/08, e BEFORE insert/update nunca toca em linha que ja
-- estava la). E escaparam da limpeza porque ela pareava por CPF -- nestes o CPF
-- esta na ficha do aluno e NULO no caso.
--
-- Vitor Velasco Rodrigues tinha os dois casos com operadores DIFERENTES
-- (cobranca12 e cobranca10) -- o cenario que faz o acionamento cair na copia e o
-- caso real parecer nunca acionado.
--
-- NAO E EXCLUSAO, E FUSAO. Em Cristiane Brizola dos Santos o caso que fica
-- estava SEM operador e herdou o dono da copia; apagar teria deixado o caso
-- orfao.
--
-- FICA o caso com nome preenchido e mais antigo. Antes de encerrar o outro, o
-- que ele tem de util sobe: operador (se o que fica estiver sem dono) e o
-- acionamento mais recente -- acionamento e fato consumado (premissa 9).
--
-- ORDEM IMPORTA: encerra a copia PRIMEIRO. A trava dispara em update e barraria
-- a alteracao do caso que fica enquanto a outra estivesse aberta.
--
-- Resultado: 4 fundidos, duplicidade por aluno = 0, base de 13.102 para 13.098.
-- Backup: public._backup_fusao_casos_20260829.

create table if not exists public._backup_fusao_casos_20260829 as
with abertos as (
  select c.id, c.aluno_id, c.nome, c.operador_email, c.operador_nome,
         c.data_ultimo_acionamento, c.status_acionamento, c.created_at
    from public.casos c
   where c.aluno_id is not null
     and not coalesce(c.encerrado_operacional,false)
     and not public.caso_encerrado_operacional(c.cpf, c.status_atual, c.status_acionamento,
                                               c.status_financeiro, c.status_jornada)
),
dup as (select aluno_id from abertos group by aluno_id having count(*) > 1),
ranqueado as (
  select a.*, row_number() over (partition by a.aluno_id
                                 order by (a.nome is null), a.created_at, a.id) rn
    from abertos a join dup d on d.aluno_id = a.aluno_id
)
select k.aluno_id, k.id as caso_fica, r.id as caso_encerra,
       k.operador_email as fica_operador_antes, r.operador_email as encerra_operador,
       k.data_ultimo_acionamento as fica_acionamento_antes,
       r.data_ultimo_acionamento as encerra_acionamento,
       now() as fundido_em
  from ranqueado k
  join ranqueado r on r.aluno_id = k.aluno_id and r.rn > 1
 where k.rn = 1;

update public.casos c
   set encerrado_operacional = true,
       caso_atualizado_por = 'sistema_fusao_casos_20260829',
       caso_atualizado_em = now()
  from public._backup_fusao_casos_20260829 b
 where c.id = b.caso_encerra;

update public.casos c
   set operador_email = coalesce(c.operador_email, b.encerra_operador),
       data_ultimo_acionamento = greatest(
         coalesce(c.data_ultimo_acionamento, '1900-01-01'::timestamptz),
         coalesce(b.encerra_acionamento,     '1900-01-01'::timestamptz))
  from public._backup_fusao_casos_20260829 b
 where c.id = b.caso_fica;

update public.casos c
   set data_ultimo_acionamento = null
  from public._backup_fusao_casos_20260829 b
 where c.id = b.caso_fica and c.data_ultimo_acionamento = '1900-01-01'::timestamptz;
