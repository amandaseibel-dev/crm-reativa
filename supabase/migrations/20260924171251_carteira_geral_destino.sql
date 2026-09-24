-- ---------------------------------------------------------------------------
-- CARTEIRA GERAL — destino operacional de gestao (fundacao)
--
-- POR QUE ISTO EXISTE
-- Hoje "tirar o caso de alguem" so tem um destino: `casos.operador_email = NULL`.
-- Esse NULL e, ao mesmo tempo, a FILA LIVRE — o pool de onde saem:
--   . assumir_caso_livre / assumir_caso_livre_aluno  (operador se serve sozinho)
--   . reposicao_carteira_processar                   (reposicao automatica)
--   . nivelar_medias_progressivo                     (job de nivelamento)
--   . calibragem_simular/executar_nivelamento        (calibragem da gestao)
-- Ou seja: recolher uma carteira para o NULL e o mesmo que devolve-la a
-- operacao no minuto seguinte — inclusive para quem acabou de perde-la.
--
-- A DECISAO: a Carteira Geral NAO e NULL. E um titular proprio, com e-mail
-- reservado, que nao e operador. Como todas as rotinas acima so pescam em
-- `operador_email IS NULL`, a Carteira Geral fica fora de todas elas por
-- construcao — sem precisar remendar consulta por consulta.
--
-- NAO E LOGIN. `carteira.geral@reativa.local` nao existe em auth.users e nao
-- tem senha (mesmo padrao de painel.tv@reativa.local). Ninguem entra "como
-- Carteira Geral": quem opera a tela entra com o proprio login (Amanda
-- gestora, Fernanda, Amanda ADM) — o mesmo trio de public.calibragem_e_gestao().
-- A linha em `usuarios` nasce com ativo=false justamente para nao aparecer em
-- nenhum seletor de pessoa da operacao (todos filtram .eq("ativo", true)).
-- `public.nome_do_operador()` nao filtra ativo, entao o rotulo continua
-- resolvendo em toda tela e gatilho.
-- ---------------------------------------------------------------------------

-- 1. O destino ------------------------------------------------------------

create or replace function internal.carteira_geral_email()
returns text
language sql
immutable
as $fn$ select 'carteira.geral@reativa.local'::text $fn$;

comment on function internal.carteira_geral_email() is
  'E-mail reservado da Carteira Geral. Nao e login: nao existe em auth.users.';

insert into public.usuarios (nome, email, perfil, ativo, operador_nome)
values ('Carteira Geral', internal.carteira_geral_email(), 'carteira', false, 'CARTEIRA GERAL')
on conflict (email) do update
   set nome = excluded.nome,
       perfil = excluded.perfil,
       ativo = excluded.ativo,
       operador_nome = excluded.operador_nome;

-- 2. Quem nao recebe caso novo -------------------------------------------
--
-- Recolher a carteira de alguem nao adianta nada se a rotina das 09:20
-- (nivelamento_automatico_gestao) devolver casos novos na manha seguinte — nem
-- se a propria pessoa puder se servir da fila livre no minuto seguinte. Este
-- flag fecha as DUAS portas de entrada:
--   . distribuicao automatica (nivelamento, reposicao, calibragem)
--   . auto-atribuicao da fila livre (assumir_caso_livre e irmas)
--
-- O que ele NAO faz: nao desativa o operador, nao tira o que ja e dele e nao
-- impede a gestao de atribuir manualmente. E "parou de entrar coisa nova", nao
-- "saiu do ar" — para isso existe `usuarios.ativo`.
alter table public.usuarios
  add column if not exists recebe_novos_casos boolean not null default true;

comment on column public.usuarios.recebe_novos_casos is
  'false = operador nao recebe caso novo: nem por rotina automatica (nivelamento, reposicao, calibragem) nem assumindo da fila livre. Nao desativa o operador e nao tira o que ja e dele.';

-- Leitura unica de "esta pessoa pode receber um caso novo?", para nao existirem
-- versoes diferentes da regra espalhadas pelas funcoes de assumir.
--
-- Reusa a definicao que JA EXISTE de operador ativo -- internal.nome_operador_ativo,
-- que exige `ativo` e perfil 'operador' (ou um dos tres e-mails da gestao) -- e
-- soma o flag novo. Ou seja: desligar alguem em `usuarios.ativo` passa a valer
-- aqui tambem, o que hoje NAO acontece.
--
-- POR QUE ISSO IMPORTA: `assumir_caso_livre` e `assumir_caso_livre_aluno`
-- protegem-se com `if public.nome_operador_por_email(v_email) is null`, mas
-- aquela funcao NUNCA devolve null -- ela cai em
-- `upper(split_part(email,'@',1))` para qualquer e-mail. A guarda e letra morta:
-- hoje um operador ja desligado (ativo=false), com a sessao ainda valida,
-- consegue assumir da fila livre. Esta funcao fecha isso.
--
-- Default agora e FALSE para e-mail desconhecido: quem nao esta em `usuarios`
-- nao deve estar pegando caso.
create or replace function internal.operador_pode_receber_caso(p_email text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select internal.nome_operador_ativo(p_email) is not null
     and coalesce((select u.recebe_novos_casos
                     from public.usuarios u
                    where lower(u.email) = lower(btrim(coalesce(p_email,'')))
                    limit 1), false);
$fn$;

comment on function internal.operador_pode_receber_caso(text) is
  'Porta unica: operador ativo (internal.nome_operador_ativo) E recebe_novos_casos. Falso para desligado, para quem nao esta em usuarios e para quem a gestao fechou.';

-- 3. Previa (o que a gestao ve ANTES de confirmar) ------------------------

create table if not exists public.carteira_geral_previas (
  id              uuid primary key default gen_random_uuid(),
  criado_em       timestamptz not null default now(),
  criado_por_email text not null,
  filtros         jsonb not null,
  destino_tipo    text not null check (destino_tipo in ('CARTEIRA_GERAL','OPERADOR','FILA_LIVRE')),
  destino_email   text,
  -- itens: a lista EXATA de alunos que serao movidos, congelada no momento da
  -- previa. A execucao so mexe no que esta aqui — se o mundo mudar entre a
  -- previa e o clique, o item divergente e recusado, nao "reinterpretado".
  itens           jsonb not null default '[]'::jsonb,
  total_alunos    integer not null default 0,
  total_acordos   integer not null default 0,
  total_valor     numeric not null default 0,
  conflitos       jsonb not null default '[]'::jsonb,
  executada_em    timestamptz,
  executada_por_email text,
  expira_em       timestamptz not null default now() + interval '2 hours'
);

create index if not exists idx_cg_previas_criado on public.carteira_geral_previas (criado_em desc);

alter table public.carteira_geral_previas enable row level security;

drop policy if exists cg_previas_gestao_le on public.carteira_geral_previas;
create policy cg_previas_gestao_le on public.carteira_geral_previas
  for select to authenticated using (public.calibragem_e_gestao());

-- 4. Auditoria (append-only) ----------------------------------------------
--
-- Uma linha por aluno movido. Guarda autor, data, motivo e a titularidade
-- ANTES e DEPOIS nas tres fontes (caso, aluno, acordos), para que desfazer
-- seja sempre possivel sem depender de PITR — que este projeto NAO tem.

create table if not exists public.carteira_geral_auditoria (
  id              uuid primary key default gen_random_uuid(),
  previa_id       uuid references public.carteira_geral_previas(id),
  lote_id         uuid not null,
  registrado_em   timestamptz not null default now(),
  autor_email     text not null,
  autor_nome      text,
  motivo          text not null,
  destino_tipo    text not null,
  aluno_id        uuid not null,
  caso_id         uuid,
  nome_aluno      text,
  cpf             text,
  -- titularidade anterior e posterior, por fonte
  caso_de_email     text,
  caso_para_email   text,
  aluno_de_email    text,
  aluno_para_email  text,
  acordos_movidos   integer not null default 0,
  acordos_detalhe   jsonb not null default '[]'::jsonb,
  valor_mensalidade numeric not null default 0,
  valor_acordo      numeric not null default 0,
  desfeito_em       timestamptz,
  desfeito_por_email text
);

create index if not exists idx_cg_auditoria_lote on public.carteira_geral_auditoria (lote_id);
create index if not exists idx_cg_auditoria_aluno on public.carteira_geral_auditoria (aluno_id, registrado_em desc);

alter table public.carteira_geral_auditoria enable row level security;

drop policy if exists cg_auditoria_gestao_le on public.carteira_geral_auditoria;
create policy cg_auditoria_gestao_le on public.carteira_geral_auditoria
  for select to authenticated using (public.calibragem_e_gestao());

-- Append-only: a auditoria so aceita a marca de "desfeito". Nada mais muda,
-- nada e apagado. Mesmo padrao de calibragem_auditoria_append_only.
create or replace function public.carteira_geral_auditoria_append_only()
returns trigger
language plpgsql
set search_path to 'public'
as $fn$
begin
  if TG_OP = 'DELETE' then
    raise exception 'carteira_geral_auditoria e append-only: nao se apaga linha de auditoria.';
  end if;
  if (to_jsonb(new) - 'desfeito_em' - 'desfeito_por_email')
     is distinct from (to_jsonb(old) - 'desfeito_em' - 'desfeito_por_email') then
    raise exception 'carteira_geral_auditoria e append-only: so desfeito_em/desfeito_por_email podem mudar.';
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_cg_auditoria_append_only on public.carteira_geral_auditoria;
create trigger trg_cg_auditoria_append_only
  before update or delete on public.carteira_geral_auditoria
  for each row execute function public.carteira_geral_auditoria_append_only();
