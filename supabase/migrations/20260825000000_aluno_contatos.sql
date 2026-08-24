-- Contatos do aluno: telefones e e-mails que ACUMULAM em vez de sobrescrever.
--
-- PROBLEMA: hoje o contato do aluno mora em três colunas soltas de `alunos` --
-- `telefone`, `telefone_resp1`, `telefone_resp2` -- e um `email`. Cada um é uma
-- casa fixa. Quando a atualização cadastral da Prime traz um número novo, ou
-- ele sobrescreve o que estava lá ou se perde. E não existe como dizer "esse
-- número não é mais dele" sem apagar: o operador liga, não é a pessoa, apaga o
-- número, e a informação de que aquele telefone é inválido some junto -- na
-- próxima importação ele volta.
--
-- DECISÕES DA AMANDA (2026-08-24):
--   * complementar os números novos, NUNCA apagar os existentes;
--   * poder invalidar um telefone (não apagar);
--   * mais de um e-mail também entra;
--   * os telefones de RESPONSÁVEL ficam como estão hoje, em `telefone_resp1` e
--     `telefone_resp2`, porque carregam o nome de quem é junto. Esta tabela é
--     só do contato do próprio aluno.
--
-- COMPATIBILIDADE: `alunos.telefone` e `alunos.email` continuam existindo e
-- sendo mantidos em dia com o contato principal válido. São lidos em 77 pontos
-- do código, em 20 arquivos -- carteira, ficha, WhatsApp, ações massivas,
-- exportações. Nada disso precisa mudar.

begin;

create table if not exists public.aluno_contatos (
  id                    uuid primary key default gen_random_uuid(),
  aluno_id              uuid not null references public.alunos(id) on delete cascade,
  tipo                  text not null check (tipo in ('telefone','email')),

  -- `valor` é a forma normalizada (só dígitos no telefone, minúsculo no
  -- e-mail) e é o que garante o "não duplica". `valor_exibicao` guarda como a
  -- pessoa escreveu ou como veio da origem.
  valor                 text not null,
  valor_exibicao        text,

  origem                text not null default 'cadastro'
                        check (origem in ('cadastro','prime','operador','importacao','whatsapp')),

  -- Principal = o que espelha em `alunos.telefone` / `alunos.email`.
  principal             boolean not null default false,

  -- Invalidar não apaga: guarda quem disse, quando e por quê. É isso que
  -- impede o número de voltar sozinho na próxima importação.
  valido                boolean not null default true,
  invalidado_em         timestamptz,
  invalidado_por_email  text,
  motivo_invalidacao    text,

  criado_em             timestamptz not null default now(),
  criado_por_email      text,

  constraint aluno_contatos_valor_nao_vazio check (length(trim(valor)) > 0),
  -- Telefone guardado no MESMO formato canônico da Central WhatsApp: DDI 55 +
  -- DDD + número (12 ou 13 dígitos). Reusar o padrão que já existe evita um
  -- terceiro jeito de escrever telefone dentro do sistema.
  constraint aluno_contatos_telefone_digitos
    check (tipo <> 'telefone' or valor ~ '^55[0-9]{10,11}$'),
  constraint aluno_contatos_email_formato
    check (tipo <> 'email' or valor ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  -- Coerência do invalidado: ou está válido e sem marca, ou inválido e com ela.
  constraint aluno_contatos_invalidacao_coerente
    check ((valido and invalidado_em is null) or (not valido and invalidado_em is not null))
);

-- O mesmo número não entra duas vezes para o mesmo aluno. É o que faz o
-- "complementar" ser idempotente: reimportar a Prime não cria linha repetida.
create unique index if not exists aluno_contatos_unico
  on public.aluno_contatos (aluno_id, tipo, valor);

-- Um principal por tipo, no máximo.
create unique index if not exists aluno_contatos_um_principal
  on public.aluno_contatos (aluno_id, tipo) where principal;

create index if not exists aluno_contatos_aluno_idx
  on public.aluno_contatos (aluno_id, tipo, valido);

comment on table public.aluno_contatos is
  'Telefones e e-mails do próprio aluno. Acumula: número novo entra sem apagar o antigo, '
  'e "não atende / não é a pessoa" vira valido=false com autor e motivo, nunca DELETE. '
  'Telefones de responsável continuam em alunos.telefone_resp1/resp2.';

alter table public.aluno_contatos enable row level security;

-- Mesmo padrão das outras tabelas de aluno: o painel da TV nunca enxerga PII.
drop policy if exists aluno_contatos_select on public.aluno_contatos;
create policy aluno_contatos_select on public.aluno_contatos
  for select to authenticated
  using (NOT public.eh_painel());

drop policy if exists painel_negado on public.aluno_contatos;
create policy painel_negado on public.aluno_contatos
  for all to authenticated
  using (NOT public.eh_painel());

-- Escrita só pelas RPCs abaixo (SECURITY DEFINER). Sem policy de INSERT/UPDATE
-- para `authenticated`, ninguém grava direto -- assim o espelho em `alunos`
-- nunca fica fora de sincronia.

-- ---------------------------------------------------------------------------
-- Normalização. Uma função só, usada pela gravação e pelo backfill, para o
-- "não duplica" valer sempre com a mesma régua.
-- ---------------------------------------------------------------------------
create or replace function public.aluno_contato_normalizar(p_tipo text, p_valor text)
returns text
language sql
immutable
as $function$
  select case
    when p_tipo = 'telefone' then public.whatsapp_normalizar_telefone(p_valor)
    when p_tipo = 'email'    then nullif(lower(trim(coalesce(p_valor,''))), '')
    else nullif(trim(coalesce(p_valor,'')), '')
  end;
$function$;

-- ---------------------------------------------------------------------------
-- Espelho em `alunos`. Roda depois de toda escrita: elege o principal (o
-- marcado, senão o válido mais antigo) e copia para a coluna legada.
-- ---------------------------------------------------------------------------
create or replace function public.aluno_contatos_sincronizar(p_aluno_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_tipo  text;
  v_tel   text;
  v_email text;
BEGIN
  FOREACH v_tipo IN ARRAY array['telefone','email'] LOOP
    -- Garante que existe exatamente um principal por tipo entre os válidos.
    IF NOT EXISTS (SELECT 1 FROM public.aluno_contatos
                    WHERE aluno_id = p_aluno_id AND tipo = v_tipo AND principal AND valido) THEN
      UPDATE public.aluno_contatos SET principal = false
       WHERE aluno_id = p_aluno_id AND tipo = v_tipo AND principal;
      UPDATE public.aluno_contatos SET principal = true
       WHERE id = (SELECT id FROM public.aluno_contatos
                    WHERE aluno_id = p_aluno_id AND tipo = v_tipo AND valido
                    ORDER BY criado_em, id LIMIT 1);
    END IF;
  END LOOP;

  SELECT coalesce(valor_exibicao, valor) INTO v_tel
    FROM public.aluno_contatos
   WHERE aluno_id = p_aluno_id AND tipo = 'telefone' AND principal AND valido;

  SELECT valor INTO v_email
    FROM public.aluno_contatos
   WHERE aluno_id = p_aluno_id AND tipo = 'email' AND principal AND valido;

  -- CUIDADO: só mexe na coluna legada de quem TEM linha desta tabela para o
  -- tipo. 3.028 telefones do cadastro não normalizam ("nao tenho", e-mail no
  -- campo, DDD duplicado ilegível) e por isso ficam fora daqui -- zerar a
  -- coluna deles seria apagar o único contato que a operação tem.
  IF EXISTS (SELECT 1 FROM public.aluno_contatos
              WHERE aluno_id = p_aluno_id AND tipo = 'telefone') THEN
    UPDATE public.alunos SET telefone = v_tel
     WHERE id = p_aluno_id AND telefone IS DISTINCT FROM v_tel;
  END IF;

  IF EXISTS (SELECT 1 FROM public.aluno_contatos
              WHERE aluno_id = p_aluno_id AND tipo = 'email') THEN
    UPDATE public.alunos SET email = v_email
     WHERE id = p_aluno_id AND email IS DISTINCT FROM v_email;
  END IF;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Adicionar. Idempotente: se o número já existe, não duplica e não ressuscita
-- um contato que alguém invalidou de propósito -- só devolve o que já está lá.
-- ---------------------------------------------------------------------------
create or replace function public.aluno_contato_adicionar(
  p_aluno_id uuid, p_tipo text, p_valor text, p_origem text default 'operador'
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_email  text := lower(coalesce(auth.email(),''));
  v_norm   text := public.aluno_contato_normalizar(p_tipo, p_valor);
  v_id     uuid;
  v_novo   boolean := false;
  v_valido boolean;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' AND NOT public.app_usuario_ativo() THEN
    RAISE EXCEPTION 'Acesso negado.' USING ERRCODE='42501';
  END IF;
  IF v_norm IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'VALOR_INVALIDO');
  END IF;
  IF p_tipo = 'telefone' AND v_norm !~ '^55[0-9]{10,11}$' THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'TELEFONE_INVALIDO', 'valor', v_norm);
  END IF;

  SELECT id, valido INTO v_id, v_valido
    FROM public.aluno_contatos
   WHERE aluno_id = p_aluno_id AND tipo = p_tipo AND valor = v_norm;

  IF v_id IS NULL THEN
    INSERT INTO public.aluno_contatos (aluno_id, tipo, valor, valor_exibicao, origem, criado_por_email)
    VALUES (p_aluno_id, p_tipo, v_norm, nullif(trim(coalesce(p_valor,'')),''), coalesce(p_origem,'operador'),
            nullif(v_email,''))
    RETURNING id INTO v_id;
    v_novo := true; v_valido := true;
  END IF;

  PERFORM public.aluno_contatos_sincronizar(p_aluno_id);
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'novo', v_novo, 'valido', v_valido, 'valor', v_norm);
END;
$function$;

-- ---------------------------------------------------------------------------
-- Invalidar / revalidar. Nunca apaga.
-- ---------------------------------------------------------------------------
create or replace function public.aluno_contato_invalidar(p_id uuid, p_motivo text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_email text := lower(coalesce(auth.email(),''));
  v_aluno uuid;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' AND NOT public.app_usuario_ativo() THEN
    RAISE EXCEPTION 'Acesso negado.' USING ERRCODE='42501';
  END IF;

  UPDATE public.aluno_contatos
     SET valido = false, principal = false,
         invalidado_em = now(),
         invalidado_por_email = nullif(v_email,''),
         motivo_invalidacao = nullif(trim(coalesce(p_motivo,'')),'')
   WHERE id = p_id AND valido
   RETURNING aluno_id INTO v_aluno;

  IF v_aluno IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'NAO_ENCONTRADO_OU_JA_INVALIDO');
  END IF;

  PERFORM public.aluno_contatos_sincronizar(v_aluno);
  RETURN jsonb_build_object('ok', true, 'aluno_id', v_aluno);
END;
$function$;

create or replace function public.aluno_contato_revalidar(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_aluno uuid;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' AND NOT public.app_usuario_ativo() THEN
    RAISE EXCEPTION 'Acesso negado.' USING ERRCODE='42501';
  END IF;

  UPDATE public.aluno_contatos
     SET valido = true, invalidado_em = null, invalidado_por_email = null, motivo_invalidacao = null
   WHERE id = p_id AND NOT valido
   RETURNING aluno_id INTO v_aluno;

  IF v_aluno IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'NAO_ENCONTRADO_OU_JA_VALIDO');
  END IF;

  PERFORM public.aluno_contatos_sincronizar(v_aluno);
  RETURN jsonb_build_object('ok', true, 'aluno_id', v_aluno);
END;
$function$;

create or replace function public.aluno_contato_tornar_principal(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_aluno uuid; v_tipo text;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' AND NOT public.app_usuario_ativo() THEN
    RAISE EXCEPTION 'Acesso negado.' USING ERRCODE='42501';
  END IF;

  SELECT aluno_id, tipo INTO v_aluno, v_tipo
    FROM public.aluno_contatos WHERE id = p_id AND valido;
  IF v_aluno IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'NAO_ENCONTRADO_OU_INVALIDO');
  END IF;

  UPDATE public.aluno_contatos SET principal = false
   WHERE aluno_id = v_aluno AND tipo = v_tipo AND principal;
  UPDATE public.aluno_contatos SET principal = true WHERE id = p_id;

  PERFORM public.aluno_contatos_sincronizar(v_aluno);
  RETURN jsonb_build_object('ok', true, 'aluno_id', v_aluno);
END;
$function$;

-- ---------------------------------------------------------------------------
-- Backfill do que já existe. Idempotente pelo índice único -- rodar de novo
-- não duplica. Só o contato do PRÓPRIO aluno; responsáveis ficam onde estão.
-- ---------------------------------------------------------------------------
insert into public.aluno_contatos (aluno_id, tipo, valor, valor_exibicao, origem, principal, criado_por_email)
select a.id, 'telefone', public.whatsapp_normalizar_telefone(a.telefone), a.telefone, 'cadastro', true, 'backfill'
  from public.alunos a
 where a.telefone is not null
   and public.whatsapp_normalizar_telefone(a.telefone) ~ '^55[0-9]{10,11}$'
on conflict (aluno_id, tipo, valor) do nothing;

insert into public.aluno_contatos (aluno_id, tipo, valor, valor_exibicao, origem, principal, criado_por_email)
select a.id, 'email', lower(trim(a.email)), a.email, 'cadastro', true, 'backfill'
  from public.alunos a
 where a.email is not null
   and lower(trim(a.email)) ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
on conflict (aluno_id, tipo, valor) do nothing;

-- Os telefones que não normalizam NÃO entram, de propósito: "(64) nao tenho",
-- e-mail digitado no campo do telefone, DDD duplicado sem como desfazer. Eles
-- continuam em `alunos.telefone` e a função de sincronizar não os toca.

commit;
