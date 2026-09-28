-- =============================================================================
-- PREVENTIVO — importação da carteira (prévia e confirmação)
-- =============================================================================
--
-- O importador do Preventivo é INDEPENDENTE do importador da cobrança
-- (`importar_acordos`, `ImportarRecuperacao`): arquivo diferente, chave
-- diferente, destino diferente, e nenhuma escrita em tabela da cobrança.
--
-- FLUXO: escolher arquivo → nomear lote → mapear colunas → PRÉVIA → confirmar.
-- A prévia e a confirmação rodam exatamente a MESMA função de validação
-- (`preventivo_lote_processar`, com `p_aplicar`), para que a prévia não possa
-- prometer um resultado diferente do que a confirmação faz.
--
-- REIMPORTAR O MESMO ARQUIVO NÃO DUPLICA NADA: a identidade do título é
-- (carteira, matrícula Prime, chave do arquivo) e a gravação é `on conflict do
-- update`. `saldo_informado` e `criado_em` nunca são reescritos.
--
-- SOBRE A PALAVRA "SALDO" NESTE ARQUIVO: ela aparece só em `saldo_informado` e
-- `saldo_informado_atualizado`, que vêm das colunas "Saldo Original" e "Saldo
-- Atualizado" do relatório da ULBRA. Ali o termo tem dono e definição: é o
-- ARQUIVO que chama aquilo de saldo em aberto. Nada vindo da API é chamado de
-- saldo em lugar nenhum — o que a API dá é `netAmount`, o VALOR DO TÍTULO NA
-- FONTE.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Normalizações de contato. Regra: nunca "consertar" número ambíguo em
-- silêncio — ou o número é válido na forma exigida, ou é separado com motivo.
-- -----------------------------------------------------------------------------
create or replace function public.preventivo_normalizar_celular(p_bruto text)
returns text
language plpgsql
immutable
as $$
declare d text;
begin
  d := regexp_replace(coalesce(p_bruto, ''), '\D', '', 'g');
  if d = '' then return null; end if;
  -- tira o 0 de operadora e o +55 quando vierem na frente
  if length(d) > 11 and left(d, 2) = '55' then d := substr(d, 3); end if;
  -- 0 de operadora na frente do DDD (0 51 9 9999-0001)
  if length(d) = 12 and left(d, 1) = '0' then d := substr(d, 2); end if;
  -- celular brasileiro: DDD (2) + 9 + 8 dígitos. Fixo (10 dígitos) NÃO passa:
  -- WhatsApp de linha fixa não existe para este uso, e completar o 9 na mão
  -- seria inventar número.
  if length(d) <> 11 then return null; end if;
  if substr(d, 1, 2)::int < 11 or substr(d, 1, 2)::int > 99 then return null; end if;
  if substr(d, 3, 1) <> '9' then return null; end if;
  return '55' || d;
end;
$$;

comment on function public.preventivo_normalizar_celular(text) is
  'Devolve 55+DDD+celular só dígitos, ou NULL. NULL inclui telefone fixo e número incompleto — nenhum dos dois é completado por conta própria.';

create or replace function public.preventivo_email_valido(p_bruto text)
returns boolean
language sql
immutable
as $$
  select coalesce(p_bruto, '') ~* '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$'
$$;

-- O campo Telefone do relatório real traz VÁRIOS números numa string só:
--   "(51) 99547-2585, CEL:(51) 991859609, CEL:5192568106, RES:51991859609"
-- Ler todos e devolver os DISTINTOS não é adivinhar. Adivinhar seria escolher
-- um quando há dois diferentes — e é por isso que, quando há mais de um, o
-- aluno é SEPARADO do público em vez de receber mensagem num número sorteado.
-- Medido em 28/09/2026: 2.688 linhas com exatamente um celular válido, 402 com
-- mais de um, 405 com nenhum.
create or replace function public.preventivo_celulares(p_bruto text)
returns text[]
language sql
immutable
set search_path to 'public'
as $$
  select coalesce(array_agg(distinct c order by c), '{}'::text[])
    from (select public.preventivo_normalizar_celular(m[1]) c
            from regexp_matches(coalesce(p_bruto, ''), '[0-9()\s.-]{8,}', 'g') m) x
   where c is not null
$$;

-- Mesma ideia para e-mail. Medido em 28/09/2026: 2.725 linhas do relatório
-- trazem mais de um endereço, 742 trazem um só, 28 nenhum válido.
create or replace function public.preventivo_emails(p_bruto text)
returns text[]
language sql
immutable
set search_path to 'public'
as $$
  select coalesce(array_agg(distinct lower(e) order by lower(e)), '{}'::text[])
    from regexp_split_to_table(coalesce(p_bruto, ''), '[;,[:space:]]+') e
   where public.preventivo_email_valido(e)
$$;

grant execute on function public.preventivo_celulares(text) to authenticated, service_role;
grant execute on function public.preventivo_emails(text) to authenticated, service_role;
grant execute on function public.preventivo_normalizar_celular(text) to authenticated, service_role;
grant execute on function public.preventivo_email_valido(text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Carteira
-- -----------------------------------------------------------------------------
create or replace function public.preventivo_carteira_criar(
  p_nome text, p_descricao text, p_venc_de date, p_venc_ate date)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_id uuid;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  if coalesce(trim(p_nome), '') = '' then
    raise exception 'Informe o nome da carteira.' using errcode = '22023';
  end if;
  if p_venc_de is null or p_venc_ate is null or p_venc_ate < p_venc_de then
    raise exception 'Informe a janela de vencimento (de/até), com "até" a partir de "de".' using errcode = '22023';
  end if;

  insert into public.prev_carteira (nome, descricao, venc_de, venc_ate, criada_por)
  values (trim(p_nome), nullif(trim(coalesce(p_descricao, '')), ''), p_venc_de, p_venc_ate,
          lower(coalesce(auth.jwt() ->> 'email', 'sistema')))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.preventivo_carteiras()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v jsonb;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(x order by x->>'criada_em' desc), '[]'::jsonb) into v
  from (
    select jsonb_build_object(
      'id', c.id, 'nome', c.nome, 'descricao', c.descricao,
      'venc_de', c.venc_de, 'venc_ate', c.venc_ate,
      'criada_em', c.criada_em, 'criada_por', c.criada_por,
      'encerrada_em', c.encerrada_em,
      'titulos', coalesce(t.n, 0), 'alunos', coalesce(t.alunos, 0),
      'saldo_informado', coalesce(t.saldo_informado, 0),
      'com_vinculo_unico', coalesce(t.com_vinculo, 0),
      'ultima_sinc', s.concluido_em
    ) as x
    from public.prev_carteira c
    left join lateral (
      select count(*) n, count(distinct matricula_prime) alunos,
             sum(saldo_informado) saldo_informado,
             count(*) filter (where vinculo_prime = 'UNICO') com_vinculo
      from public.prev_titulo where carteira_id = c.id
    ) t on true
    left join lateral (
      select max(concluido_em) concluido_em from public.prev_sinc
      where status = 'CONCLUIDA' and (carteira_id = c.id or carteira_id is null)
    ) s on true
  ) q;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- Processamento do lote. `p_aplicar = false` é a PRÉVIA: valida tudo, não
-- grava nada, e devolve o mesmo resumo que a confirmação devolveria.
-- -----------------------------------------------------------------------------
create or replace function public.preventivo_lote_processar(
  p_carteira_id uuid,
  p_linhas jsonb,
  p_aplicar boolean,
  p_lote_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_carteira  public.prev_carteira%rowtype;
  v_hoje      date := public.preventivo_hoje();
  v_limite    int  := public.preventivo_limite_dias();
  v_resumo    jsonb;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  select * into v_carteira from public.prev_carteira where id = p_carteira_id;
  if not found then
    raise exception 'Carteira não encontrada.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_linhas) <> 'array' then
    raise exception 'Envie as linhas do arquivo como lista.' using errcode = '22023';
  end if;

  create temp table _prev_in on commit drop as
  select
    (ord)::int                                         as linha,
    nullif(trim(l->>'matricula'), '')                  as matricula,
    nullif(trim(l->>'documento'), '')                  as documento,
    nullif(trim(l->>'unidade'), '')                    as unidade,
    nullif(trim(l->>'contrato'), '')                   as contrato,
    nullif(trim(l->>'aluno_nome'), '')                 as aluno_nome,
    nullif(regexp_replace(coalesce(l->>'cpf',''), '\D', '', 'g'), '') as cpf,
    nullif(trim(l->>'competencia'), '')                as competencia,
    case when (l->>'vencimento') ~ '^\d{4}-\d{2}-\d{2}$' then (l->>'vencimento')::date end as vencimento,
    case when (l->>'vencimento_origem') ~ '^\d{4}-\d{2}-\d{2}$' then (l->>'vencimento_origem')::date end as vencimento_origem,
    case when (l->>'valor') ~ '^-?\d+(\.\d+)?$' then (l->>'valor')::numeric end            as valor,
    case when (l->>'saldo') ~ '^-?\d+(\.\d+)?$' then (l->>'saldo')::numeric end            as saldo,
    case when (l->>'saldo_atualizado') ~ '^-?\d+(\.\d+)?$' then (l->>'saldo_atualizado')::numeric end as saldo_atualizado,
    nullif(trim(l->>'situacao'), '')                   as situacao,
    public.preventivo_celulares(l->>'celular')         as celulares,
    public.preventivo_emails(l->>'email')              as emails,
    l                                                  as bruto
  from jsonb_array_elements(p_linhas) with ordinality as e(l, ord);

  -- CHAVE DO TÍTULO DENTRO DA CARTEIRA. O relatório real de inadimplência da
  -- ULBRA (medido em 28/09/2026) não traz identificador de título: traz
  -- matrícula, vencimento atual e vencimento de origem. Quando o arquivo
  -- trouxer um identificador, ele manda; senão, a chave é o par de datas.
  -- Um número só, e sem escolher: quando há mais de um celular DIFERENTE na
  -- linha, nenhum é adotado — o aluno fica marcado como ambíguo e é separado
  -- na hora de montar o público.
  alter table _prev_in add column celular_aluno text;
  alter table _prev_in add column email_aluno text;
  update _prev_in set
    celular_aluno = case when array_length(celulares, 1) = 1 then celulares[1] end,
    email_aluno   = case when array_length(emails, 1) = 1 then emails[1] end;

  alter table _prev_in add column chave text;
  update _prev_in set chave = coalesce(
    documento,
    coalesce(vencimento::text, '?') || '|' || coalesce(vencimento_origem::text, ''));

  alter table _prev_in add column motivo text;
  update _prev_in set motivo =
    case
      when matricula  is null then 'SEM_MATRICULA'
      when aluno_nome is null then 'SEM_NOME'
      when vencimento is null then 'VENCIMENTO_INVALIDO'
      when coalesce(valor, saldo) is null or coalesce(valor, saldo) <= 0 then 'VALOR_INVALIDO'
      when vencimento < v_carteira.venc_de or vencimento > v_carteira.venc_ate then 'FORA_DO_PERIODO'
    end;

  -- Duplicidade DENTRO do arquivo: a primeira ocorrência entra, a repetida é
  -- separada. Reimportar o arquivo inteiro continua sem duplicar título.
  update _prev_in a set motivo = 'DUPLICADA_NO_ARQUIVO'
  where a.motivo is null
    and exists (select 1 from _prev_in b
                where b.motivo is null and b.matricula = a.matricula
                  and b.chave = a.chave and b.linha < a.linha);

  -- Quando o arquivo TEM identificador de título, o mesmo identificador em
  -- duas matrículas não funde nada: recusa a linha.
  update _prev_in a set motivo = 'DOCUMENTO_EM_OUTRA_MATRICULA'
  where a.motivo is null and a.documento is not null
    and exists (select 1 from public.prev_titulo t
                where t.carteira_id = p_carteira_id and t.documento = a.documento
                  and t.matricula_prime <> a.matricula);

  if p_aplicar then
    if p_lote_id is null then
      raise exception 'Confirmação de importação exige o lote.' using errcode = '22023';
    end if;

    insert into public.prev_lote_recusa (lote_id, linha, motivo, dados)
    select p_lote_id, linha, motivo, bruto from _prev_in where motivo is not null;

    -- Gravação idempotente. `saldo_informado` e `lote_origem_id` só valem na
    -- primeira entrada do título na carteira; depois disso são história.
    with gravados as (
      insert into public.prev_titulo as t (
        carteira_id, matricula_prime, documento, vencimento, vencimento_origem,
        chave_arquivo, unidade, contrato, aluno_nome, cpf, competencia,
        valor_original, saldo_informado, saldo_informado_atualizado, situacao_origem,
        celular_aluno, email_aluno, celulares_no_arquivo, emails_no_arquivo,
        lote_origem_id, lote_ultimo_id, status)
      select
        p_carteira_id, i.matricula, i.documento, i.vencimento, i.vencimento_origem,
        i.chave, i.unidade, i.contrato, i.aluno_nome, i.cpf, i.competencia,
        coalesce(i.valor, i.saldo), coalesce(i.saldo, i.valor), i.saldo_atualizado, i.situacao,
        i.celular_aluno, i.email_aluno,
        coalesce(array_length(i.celulares, 1), 0), coalesce(array_length(i.emails, 1), 0),
        p_lote_id, p_lote_id,
        case when (v_hoje - i.vencimento) > v_limite then 'FORA_DA_JANELA' else 'ATIVO' end
      from _prev_in i where i.motivo is null
      on conflict (carteira_id, matricula_prime, chave_arquivo) do update set
        aluno_nome     = excluded.aluno_nome,
        cpf            = coalesce(excluded.cpf, t.cpf),
        documento      = coalesce(excluded.documento, t.documento),
        unidade        = coalesce(excluded.unidade, t.unidade),
        contrato       = coalesce(excluded.contrato, t.contrato),
        competencia    = coalesce(excluded.competencia, t.competencia),
        vencimento     = excluded.vencimento,
        vencimento_origem = coalesce(excluded.vencimento_origem, t.vencimento_origem),
        valor_original = excluded.valor_original,
        saldo_informado_atualizado = coalesce(excluded.saldo_informado_atualizado, t.saldo_informado_atualizado),
        situacao_origem= coalesce(excluded.situacao_origem, t.situacao_origem),
        celular_aluno  = coalesce(excluded.celular_aluno, t.celular_aluno),
        email_aluno    = coalesce(excluded.email_aluno, t.email_aluno),
        celulares_no_arquivo = greatest(excluded.celulares_no_arquivo, t.celulares_no_arquivo),
        emails_no_arquivo    = greatest(excluded.emails_no_arquivo, t.emails_no_arquivo),
        lote_ultimo_id = excluded.lote_ultimo_id,
        atualizado_em  = now()
      returning t.id, (xmax = 0) as nasceu
    )
    insert into public.prev_titulo_lote (titulo_id, lote_id, primeira_vez)
    select id, p_lote_id, nasceu from gravados
    on conflict (titulo_id, lote_id) do nothing;
  end if;

  select jsonb_build_object(
    'linhas_lidas',        (select count(*) from _prev_in),
    'linhas_aceitas',      (select count(*) from _prev_in where motivo is null),
    'linhas_recusadas',    (select count(*) from _prev_in where motivo is not null),
    'alunos',              (select count(distinct matricula) from _prev_in where motivo is null),
    'titulos',             (select count(*) from _prev_in where motivo is null),
    'valor_total',         (select coalesce(sum(coalesce(saldo, valor)), 0) from _prev_in where motivo is null),
    'novos',               (select count(*) from _prev_in i where i.motivo is null
                              and not exists (select 1 from public.prev_titulo t
                                              where t.carteira_id = p_carteira_id
                                                and t.matricula_prime = i.matricula
                                                and t.chave_arquivo = i.chave)),
    'atualizados',         (select count(*) from _prev_in i where i.motivo is null
                              and exists (select 1 from public.prev_titulo t
                                          where t.carteira_id = p_carteira_id
                                            and t.matricula_prime = i.matricula
                                            and t.chave_arquivo = i.chave)),
    'sem_identificador_de_titulo', (select count(*) from _prev_in where motivo is null and documento is null),
    'mesmo_vencimento_no_arquivo', (select count(*) from _prev_in a where a.motivo is null
                                      and exists (select 1 from _prev_in b where b.motivo is null
                                                  and b.matricula = a.matricula and b.vencimento = a.vencimento
                                                  and b.chave <> a.chave)),
    'fora_da_janela',      (select count(*) from _prev_in where motivo is null and (v_hoje - vencimento) > v_limite),
    'sem_celular_valido',  (select count(*) from _prev_in where motivo is null and coalesce(array_length(celulares,1),0) = 0),
    'celular_ambiguo',     (select count(*) from _prev_in where motivo is null and coalesce(array_length(celulares,1),0) > 1),
    'sem_email_valido',    (select count(*) from _prev_in where motivo is null and coalesce(array_length(emails,1),0) = 0),
    'email_multiplo',      (select count(*) from _prev_in where motivo is null and coalesce(array_length(emails,1),0) > 1),
    'celular_compartilhado', (select count(*) from _prev_in a where a.motivo is null and a.celular_aluno is not null
                                and exists (select 1 from _prev_in b where b.motivo is null
                                            and b.celular_aluno = a.celular_aluno and b.matricula <> a.matricula)),
    'recusas_por_motivo',  (select coalesce(jsonb_object_agg(motivo, n), '{}'::jsonb)
                              from (select motivo, count(*) n from _prev_in where motivo is not null group by 1) r),
    'exemplos_recusa',     (select coalesce(jsonb_agg(jsonb_build_object('linha', linha, 'motivo', motivo)), '[]'::jsonb)
                              from (select linha, motivo from _prev_in where motivo is not null order by linha limit 20) x)
  ) into v_resumo;

  return v_resumo;
end;
$$;

create or replace function public.preventivo_lote_previa(p_carteira_id uuid, p_linhas jsonb)
returns jsonb
language plpgsql
-- VOLATILE de propósito: a prévia cria tabela temporária para validar as
-- linhas, e o Postgres recusa escrita dentro de função STABLE. A prévia não
-- grava nada em `prev_titulo` — quem decide isso é `p_aplicar = false`.
security definer
set search_path to 'public'
as $$
begin
  return public.preventivo_lote_processar(p_carteira_id, p_linhas, false, null);
end;
$$;

create or replace function public.preventivo_lote_confirmar(
  p_carteira_id uuid, p_nome text, p_arquivo text, p_mapeamento jsonb,
  p_conteudo_hash text, p_linhas jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_lote uuid; v_resumo jsonb;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  if coalesce(trim(p_nome), '') = '' then
    raise exception 'Dê um nome ao lote antes de confirmar.' using errcode = '22023';
  end if;
  if exists (select 1 from public.prev_lote where carteira_id = p_carteira_id and nome = trim(p_nome)) then
    raise exception 'Já existe um lote com este nome nesta carteira. Use outro nome — o histórico de cada lote é preservado.' using errcode = '23505';
  end if;

  insert into public.prev_lote (carteira_id, nome, arquivo_nome, mapeamento, conteudo_hash, criado_por)
  values (p_carteira_id, trim(p_nome), nullif(trim(coalesce(p_arquivo, '')), ''),
          coalesce(p_mapeamento, '{}'::jsonb), nullif(trim(coalesce(p_conteudo_hash, '')), ''),
          lower(coalesce(auth.jwt() ->> 'email', 'sistema')))
  returning id into v_lote;

  v_resumo := public.preventivo_lote_processar(p_carteira_id, p_linhas, true, v_lote);
  update public.prev_lote set resumo = v_resumo where id = v_lote;
  return v_resumo || jsonb_build_object('lote_id', v_lote);
end;
$$;

create or replace function public.preventivo_lotes(p_carteira_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v jsonb;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', l.id, 'nome', l.nome, 'arquivo', l.arquivo_nome, 'status', l.status,
    'criado_em', l.criado_em, 'criado_por', l.criado_por, 'resumo', l.resumo,
    'titulos', (select count(*) from public.prev_titulo_lote tl where tl.lote_id = l.id),
    'recusas', (select count(*) from public.prev_lote_recusa r where r.lote_id = l.id)
  ) order by l.criado_em desc), '[]'::jsonb) into v
  from public.prev_lote l where l.carteira_id = p_carteira_id;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- Janela: quem passou de 31 dias sai das ações NOVAS e fica no histórico.
-- Não transfere nada para a cobrança — essa decisão é humana e não é daqui.
-- -----------------------------------------------------------------------------
create or replace function public.preventivo_janela_aplicar()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_saiu int; v_voltou int; v_hoje date := public.preventivo_hoje();
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;

  update public.prev_titulo
     set status = 'FORA_DA_JANELA', saiu_em = v_hoje,
         saida_motivo = 'Passou de ' || public.preventivo_limite_dias() || ' dias de atraso sobre o vencimento atual',
         atualizado_em = now()
   where status = 'ATIVO' and (v_hoje - vencimento) > public.preventivo_limite_dias();
  get diagnostics v_saiu = row_count;

  -- vencimento corrigido numa reimportação pode devolver o título à janela
  update public.prev_titulo
     set status = 'ATIVO', saiu_em = null, saida_motivo = null, atualizado_em = now()
   where status = 'FORA_DA_JANELA' and (v_hoje - vencimento) <= public.preventivo_limite_dias();
  get diagnostics v_voltou = row_count;

  return jsonb_build_object('sairam', v_saiu, 'voltaram', v_voltou, 'hoje', v_hoje);
end;
$$;

revoke all on function public.preventivo_carteira_criar(text, text, date, date) from public;
revoke all on function public.preventivo_carteiras() from public;
revoke all on function public.preventivo_lote_processar(uuid, jsonb, boolean, uuid) from public;
revoke all on function public.preventivo_lote_previa(uuid, jsonb) from public;
revoke all on function public.preventivo_lote_confirmar(uuid, text, text, jsonb, text, jsonb) from public;
revoke all on function public.preventivo_lotes(uuid) from public;
revoke all on function public.preventivo_janela_aplicar() from public;

grant execute on function public.preventivo_carteira_criar(text, text, date, date) to authenticated, service_role;
grant execute on function public.preventivo_carteiras() to authenticated, service_role;
grant execute on function public.preventivo_lote_previa(uuid, jsonb) to authenticated, service_role;
grant execute on function public.preventivo_lote_confirmar(uuid, text, text, jsonb, text, jsonb) to authenticated, service_role;
grant execute on function public.preventivo_lotes(uuid) to authenticated, service_role;
grant execute on function public.preventivo_janela_aplicar() to authenticated, service_role;
-- `preventivo_lote_processar` é interna: só as duas funções acima a chamam.
grant execute on function public.preventivo_lote_processar(uuid, jsonb, boolean, uuid) to service_role;
