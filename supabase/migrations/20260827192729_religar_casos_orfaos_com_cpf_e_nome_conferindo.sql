-- Religar caso orfao ao aluno -- so quando CPF e NOME conferem.
--
-- Amanda, 27/08/2026, depois de descobrir que caso orfao quebrava a lista:
-- "consegue ajustar de todos?".
--
-- O ESTRAGO. 761 casos sem aluno_id. Alem de nao poderem ser trabalhados, eles
-- quebravam a lista de "risco de perder" de quem os tivesse (Diego, Rafaella,
-- Mauricio) -- ver 20260827220000.
--
-- POR QUE PERDERAM O ALUNO: NENHUM dos 761 tem CPF com 11 digitos. 696 estao
-- curtos -- zero a esquerda perdido, o mesmo defeito de planilha que gerou os
-- cadastros duplicados do Ricardo e da Bruna. Sem os 11 digitos, o vinculo por
-- CPF nunca fechou.
--
-- A ARMADILHA QUE QUASE ME PEGOU. Completando com zeros a esquerda, 702 dos
-- 705 com CPF acham UM aluno, sem ambiguidade nenhuma. Parecia seguro. Mas ao
-- conferir o nome, 21 apontavam para OUTRA PESSOA:
--
--     "Jonathan de Melo Rodrigues"  ->  Kamila Bruce Araujo
--     "Sara Brito da Silva"         ->  Tiago Teixeira Moreira
--     "Samuel Pereira"              ->  Suzanara Agostinetto
--
-- Sao CPFs que perderam VARIOS digitos; o preenchimento com zeros produz um
-- numero valido que bate por acaso no CPF de outro aluno. Vincular por CPF
-- sozinho teria jogado 21 casos na carteira da pessoa errada -- com divida,
-- cobranca e acionamento junto.
--
-- A REGRA: CPF (completado) E NOME identico, com o CPF achando UM aluno so.
-- Religou 678. Sobraram 83 para conferencia humana:
--     21 com nome divergente (18 sao pessoa diferente, 3 sao erro de digitacao
--        tipo "Ferrreira"/"Ferreira" -- da para religar a mao)
--      3 sem nome no caso, impossivel conferir
--      3 que nao acham aluno nenhum
--     56 sem CPF
-- Dos que sobraram, so 2 tem operador -- entao a lista de ninguem quebra mais.
--
-- Guarda o estado anterior em _backup_casos_orfaos_religados, para reverter.

create table if not exists public._backup_casos_orfaos_religados (
  caso_id uuid primary key,
  aluno_id_novo uuid not null,
  cpf_limpo_antes text,
  nome_caso text,
  nome_aluno text,
  operador_email text,
  religado_em timestamptz not null default now()
);

with candidato as (
  select c.id as caso_id, a.id as aluno_id, c.cpf_limpo, c.nome as nome_caso,
         a.nome as nome_aluno, c.operador_email
  from public.casos c
  join public.alunos a
    on lpad(regexp_replace(coalesce(a.cpf,''),'\D','','g'),11,'0')
     = lpad(regexp_replace(coalesce(c.cpf_limpo,''),'\D','','g'),11,'0')
  where c.aluno_id is null
    and coalesce(c.cpf_limpo,'') <> ''
    and coalesce(c.nome,'') <> ''
    -- NOME tem que conferir. Sem isto, 21 casos iriam para a pessoa errada.
    and upper(btrim(c.nome)) = upper(btrim(coalesce(a.nome,'')))
    -- E o CPF completado tem que achar UM aluno so.
    and (select count(*) from public.alunos a2
          where lpad(regexp_replace(coalesce(a2.cpf,''),'\D','','g'),11,'0')
              = lpad(regexp_replace(coalesce(c.cpf_limpo,''),'\D','','g'),11,'0')) = 1
)
insert into public._backup_casos_orfaos_religados
  (caso_id, aluno_id_novo, cpf_limpo_antes, nome_caso, nome_aluno, operador_email)
select caso_id, aluno_id, cpf_limpo, nome_caso, nome_aluno, operador_email from candidato
on conflict (caso_id) do nothing;

update public.casos c
   set aluno_id = b.aluno_id_novo
  from public._backup_casos_orfaos_religados b
 where b.caso_id = c.id
   and c.aluno_id is null;
