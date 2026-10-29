-- ============================================================================
-- O NOME DO OPERADOR PASSA A VIR DO CADASTRO
-- ----------------------------------------------------------------------------
-- Sintoma: na Efetividade, as linhas de Olga (cobranca03), Mauricio
-- (cobranca06) e Allan (cobranca11) apareciam com o nome RAFAELLA.
--
-- Causa: quando um caso troca de dono, o `operador_email` e atualizado mas o
-- `operador_nome` antigo continua gravado na linha. O mesmo e-mail passa a
-- carregar varios nomes (ate 7 em cobranca06) e as RPCs escolhiam o nome com
-- `max(operador_nome)` -- ou seja, o maior em ordem alfabetica. "RAFAELLA"
-- comeca com R e ganhava de OLGA, MAURICIO, JOAO, LUANA, DIEGO, ALLAN.
-- Os numeros sempre foram do operador certo (vem do e-mail); so o rotulo
-- estava trocado.
--
-- Conserto, em tres camadas:
--   1) `nome_do_operador(email)` -- fonte unica, le `usuarios`;
--   2) backfill de `casos` e `alunos` (nome desatualizado gravado na linha);
--   3) gatilho que mantem o nome alinhado ao e-mail daqui pra frente;
--   4) as RPCs da Efetividade/Saude param de adivinhar o nome com max().
--
-- Reversivel: rollback + tabelas de backup com os valores anteriores.
--
-- APLICADO EM PROD 2026-09-01 em tres passos (a primeira tentativa em bloco
-- unico deu deadlock com o trafego ao vivo): funcao+backup, backfill por
-- operador (lock_timeout de 5s), gatilhos. O resultado e o mesmo deste arquivo.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Fonte unica do nome
-- ---------------------------------------------------------------------------
create or replace function public.nome_do_operador(p_email text)
returns text
language sql stable
set search_path = public as $$
  select coalesce(nullif(btrim(u.operador_nome), ''), nullif(btrim(u.nome), ''))
  from public.usuarios u
  where lower(u.email) = lower(btrim(p_email))
  limit 1;
$$;

grant execute on function public.nome_do_operador(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Backup dos nomes que estao gravados hoje (deny-all, so service_role)
-- ---------------------------------------------------------------------------
create table if not exists public._backup_nome_operador_casos_20260901 as
  select id, operador_email, operador_nome, operador
  from public.casos
  where operador_email is not null;

create table if not exists public._backup_nome_operador_alunos_20260901 as
  select id, operador_email, operador_nome, responsavel_atual_email, responsavel_atual_nome
  from public.alunos
  where operador_email is not null or responsavel_atual_email is not null;

alter table public._backup_nome_operador_casos_20260901 enable row level security;
alter table public._backup_nome_operador_alunos_20260901 enable row level security;

-- ---------------------------------------------------------------------------
-- 3. Backfill: o nome gravado passa a ser o do cadastro
-- ---------------------------------------------------------------------------
update public.casos c
   set operador_nome = public.nome_do_operador(c.operador_email),
       operador      = public.nome_do_operador(c.operador_email)
 where c.operador_email is not null
   and public.nome_do_operador(c.operador_email) is not null
   and (c.operador_nome is distinct from public.nome_do_operador(c.operador_email)
     or c.operador      is distinct from public.nome_do_operador(c.operador_email));

update public.alunos a
   set operador_nome = public.nome_do_operador(a.operador_email)
 where a.operador_email is not null
   and public.nome_do_operador(a.operador_email) is not null
   and a.operador_nome is distinct from public.nome_do_operador(a.operador_email);

update public.alunos a
   set responsavel_atual_nome = public.nome_do_operador(a.responsavel_atual_email)
 where a.responsavel_atual_email is not null
   and public.nome_do_operador(a.responsavel_atual_email) is not null
   and a.responsavel_atual_nome is distinct from public.nome_do_operador(a.responsavel_atual_email);

-- ---------------------------------------------------------------------------
-- 4. Daqui pra frente: quem escreve o e-mail nao escolhe mais o nome
-- ---------------------------------------------------------------------------
create or replace function public._nome_do_operador_no_caso()
returns trigger
language plpgsql
set search_path = public as $$
declare v_nome text;
begin
  if new.operador_email is not null then
    v_nome := public.nome_do_operador(new.operador_email);
    if v_nome is not null then
      new.operador_nome := v_nome;
      new.operador := v_nome;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_nome_do_operador_no_caso on public.casos;
create trigger trg_nome_do_operador_no_caso
  before insert or update of operador_email, operador_nome, operador on public.casos
  for each row execute function public._nome_do_operador_no_caso();

create or replace function public._nome_do_operador_no_aluno()
returns trigger
language plpgsql
set search_path = public as $$
declare v_nome text;
begin
  if new.operador_email is not null then
    v_nome := public.nome_do_operador(new.operador_email);
    if v_nome is not null then new.operador_nome := v_nome; end if;
  end if;
  if new.responsavel_atual_email is not null then
    v_nome := public.nome_do_operador(new.responsavel_atual_email);
    if v_nome is not null then new.responsavel_atual_nome := v_nome; end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_nome_do_operador_no_aluno on public.alunos;
create trigger trg_nome_do_operador_no_aluno
  before insert or update of operador_email, operador_nome,
                             responsavel_atual_email, responsavel_atual_nome on public.alunos
  for each row execute function public._nome_do_operador_no_aluno();

commit;
