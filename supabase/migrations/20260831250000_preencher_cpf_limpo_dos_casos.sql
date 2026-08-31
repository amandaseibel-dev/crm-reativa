-- Caso sem CPF perde a protecao do acordo -- e eram 1.982 casos.
--
-- Amanda, 31/08: "acordos a vencer estao perdendo o caso para os operadores" e,
-- antes, "se existe um erro ele precisa ser corrigido em todos os casos".
--
-- O DEFEITO. `caso_protegido_redistribuicao` recebe `casos.cpf_limpo` e faz:
--
--   v_cpf := lpad(regexp_replace(coalesce(p_cpf_limpo,''), '\D','','g'), 11, '0');
--   if v_cpf = '00000000000' or v_cpf = '' then null;   -- <<< PULA a checagem
--   elsif exists (select 1 from acordos a where a.cpf = v_cpf and a.status='ATIVO')
--     ...  then return true;                            -- protegido
--
-- Com `cpf_limpo` vazio, o CPF vira onze zeros e o codigo DESVIA da verificacao
-- de acordo ativo, de baixa aguardando, de link enviado e de confirmacao
-- pendente. O caso fica desprotegido por um campo em branco -- nao por nenhuma
-- regra de negocio.
--
-- Medido em 31/08:
--   casos sem cpf_limpo                              1.982
--     desses, com acordo ATIVO (protecao pulada)       219
--   preenchidos pelo CPF do proprio aluno            1.912
--   restantes (aluno tambem sem CPF valido)             70
--   sem cpf E com acordo ativo, DEPOIS                   0
--
-- A correcao copia o CPF que ja existe na ficha do aluno, normalizado como o
-- resto do sistema faz. Nao inventa dado e nao muda valor financeiro nenhum.
--
-- ISTO NAO E SO SOBRE FIDELIZACAO: qualquer regra que procure por CPF -- e sao
-- varias -- falhava em silencio nesses casos.
--
-- DESFAZER: supabase/rollbacks/20260831250000_preencher_cpf_limpo_dos_casos.rollback.sql

create table if not exists public._backup_cpf_limpo_casos_20260831 as
select c.id caso_id, c.cpf_limpo cpf_limpo_antes, now() as backup_em
  from public.casos c
 where coalesce(c.cpf_limpo,'') = '';

alter table public._backup_cpf_limpo_casos_20260831 enable row level security;

update public.casos c
   set cpf_limpo = lpad(regexp_replace(al.cpf, '\D', '', 'g'), 11, '0'),
       caso_atualizado_em = now()
  from public.alunos al
 where al.id = c.aluno_id
   and coalesce(c.cpf_limpo,'') = ''
   and length(regexp_replace(coalesce(al.cpf,''), '\D', '', 'g')) = 11;
