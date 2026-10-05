-- ============================================================================
-- J3 · I1 — CAPTURA DE PRESENÇA POR EXTRAÇÃO
--
-- ⛔ NÃO APLICAR antes da revisão do pacote (docs/J3-I1-PACOTE-FINAL-2026-10-01.md).
--
-- ESCOPO: SOMENTE CAPTURA. Nenhuma inferência de vínculo, ausência ou exclusão
-- financeira é implementada. A view de histórico é DIAGNÓSTICO.
--
-- GARANTIAS (testadas — ver T1..T14 do pacote):
--   · nenhuma escrita em acordos_titulos, parcelas, acordos, casos, alunos
--   · nenhum vínculo criado · nenhum saldo alterado · nenhuma fila alterada
--   · nenhuma classificação de título alterada
--   · append-only: UPDATE/DELETE recusados por gatilho
--   · idempotente por hash do arquivo (SHA-256)
--   · ausência só comparável entre TOTAL_VALIDADO → TOTAL_VALIDADO do mesmo escopo
--
-- PITR NÃO habilitado neste projeto. Rollback = DROP (objetos novos, sem DML).
-- ============================================================================

-- SEM `begin;`/`commit;` AQUI, DE PROPOSITO.
-- O Supabase CLI e apply_migration JA envolvem cada migration numa
-- transacao. Um `commit;` interno encerraria esse envelope no meio: se
-- uma instrucao posterior falhasse, as anteriores ja estariam COMMITADAS
-- -- a migration perderia a atomicidade. E as 6 ultimas migrations reais
-- do projeto tem ZERO begin/commit: esta e a convencao.
-- Consequencia pratica: este arquivo pode ser exercitado literalmente
-- dentro de BEGIN; ... ROLLBACK; sem risco de aplicar nada.

-- ---------------------------------------------------------------------------
-- 0. DICIONÁRIO DE RÓTULOS  (normalização de armazenamento)
--    Medido em 2026-10-01: tipo_boleto tem 8 valores distintos com MÉDIA DE 29
--    caracteres; situacao tem 6 valores com média 6. Repetir esses textos em
--    ~48.000 linhas por extração é o payload pesado que a gestão pediu para
--    não duplicar. Viram smallint (2 bytes) -> economia de ~33 bytes/linha.
-- ---------------------------------------------------------------------------
create table if not exists public.extracao_rotulo (
  id         smallserial primary key,
  dominio    text not null check (dominio in ('TIPO_BOLETO','SITUACAO')),
  valor      text not null,
  created_at timestamptz not null default now(),
  constraint ux_extracao_rotulo unique (dominio, valor)
);

comment on table public.extracao_rotulo is
  'J3: dicionario de rotulos observados nas extracoes. Normaliza tipo_boleto '
  '(8 valores, media 29 chars) e situacao (6 valores) para smallint. '
  'APPEND-ONLY: rotulo novo e adicionado, nunca reescrito -- inclusive os '
  'mojibake tipo "Cursos de GraduaÁ„o Presencial", que sao dado historico.';

create or replace function public.extracao_rotulo_id(p_dominio text, p_valor text)
returns smallint language plpgsql security definer set search_path to 'public' as $$
declare v_id smallint;
begin
  if p_valor is null or btrim(p_valor) = '' then return null; end if;
  select id into v_id from public.extracao_rotulo
   where dominio = p_dominio and valor = btrim(p_valor);
  if v_id is not null then return v_id; end if;
  insert into public.extracao_rotulo (dominio, valor) values (p_dominio, btrim(p_valor))
    on conflict (dominio, valor) do nothing returning id into v_id;
  if v_id is null then
    select id into v_id from public.extracao_rotulo
     where dominio = p_dominio and valor = btrim(p_valor);
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. ESCOPO DA EXTRAÇÃO + MÁQUINA DE ESTADOS DE VALIDAÇÃO
--
--    estado:
--      PARCIAL                   -> nunca participa de inferencia de ausencia
--      TOTAL_PENDENTE_VALIDACAO  -> declarado TOTAL, ainda NAO serve de prova
--      TOTAL_VALIDADO            -> unico estado comparavel
--      TOTAL_REPROVADO           -> gestao recusou (arquivo truncado etc.)
--
--    Declarar TOTAL NAO basta: a RPC compara com o ultimo TOTAL_VALIDADO do
--    mesmo escopo e so promove a VALIDADO automaticamente dentro das faixas.
-- ---------------------------------------------------------------------------
create table if not exists public.extracao_escopo (
  id                uuid primary key default gen_random_uuid(),
  importacao_id     uuid not null references public.importacoes(id),
  source_type       text not null
      check (source_type in ('RELATORIO_TITULOS_ABERTO','BORDERO')),
  -- escopo institucional. Qualquer filtro que mude a populacao esperada entra
  -- aqui. Duas extracoes so sao comparaveis com source_type+scope_key iguais.
  scope_key         text not null,
  completude        text not null check (completude in ('TOTAL','PARCIAL')),
  estado            text not null
      check (estado in ('PARCIAL','TOTAL_PENDENTE_VALIDACAO',
                        'TOTAL_VALIDADO','TOTAL_REPROVADO')),
  -- instante da EXTRACAO na ULBRA, nunca do upload: arquivo enviado fora de
  -- ordem precisa ordenar pela extracao, senao a ausencia inverte.
  snapshot_at       timestamptz not null,
  arquivo_nome      text,
  arquivo_hash      text not null,          -- SHA-256 do arquivo (idempotencia)
  linhas_arquivo    integer not null,       -- TOTAL de linhas, nao o subconjunto
  linhas_capturadas integer not null,
  titulos_distintos integer,
  alunos_distintos  integer,
  valor_total       numeric(16,2),
  -- auditoria da decisao automatica
  validacao_motivo  jsonb,
  validado_por      text,
  validado_em       timestamptz,
  declarado_por     text not null,
  observacao        text,
  created_at        timestamptz not null default now(),
  constraint ux_extracao_escopo_importacao unique (importacao_id),
  -- ============ IDEMPOTENCIA: UNIQUE GLOBAL, decidido com evidencia ============
  -- Contrato: O MESMO ARQUIVO E SEMPRE A MESMA OBSERVACAO, independentemente de
  -- quem, quando ou por qual fluxo foi enviado. O conteudo determina a
  -- populacao coberta; bytes iguais = mesma cobertura = mesma observacao.
  --
  -- Medido em producao 2026-10-01, sobre 163 uploads do relatorio e 97 borderos:
  --   · o relatorio tem UM unico escopo em todo o historico;
  --   · os 4 borderos reimportados repetiram a MESMA referencia (mesmo escopo);
  --   · ZERO arquivos com o mesmo nome e referencias diferentes;
  --   · 1 unico reenvio de arquivo identico (17h depois) -- que esta regra dedupa.
  -- Nao ha, no fluxo real, caso em que o mesmo arquivo precise existir em dois
  -- escopos.
  --
  -- Por que NAO (arquivo_hash, scope_key): no bordero a scope_key vem do NOME DO
  -- ARQUIVO (extrairNumeroBordero). Bytes identicos sob dois numeros significa
  -- que alguem renomeou o arquivo -- um ERRO. O UNIQUE global recusa; a chave
  -- composta criaria em silencio dois snapshots do mesmo bordero com numeros
  -- diferentes, e a ausencia derivada dali seria ficcao.
  --
  -- Custo de um falso bloqueio: ZERO. A RPC nao lanca erro -- devolve o escopo
  -- existente com reaproveitado=true, e a importacao financeira segue normal.
  constraint ux_extracao_escopo_hash       unique (arquivo_hash),
  -- CONTRATO DO BORDERO (item 7): o formato da scope_key amarra o source_type,
  -- entao um bordero NUNCA pode entrar na sequencia do portador 195 nem ser
  -- comparado com BORDERO=TODOS -- sao scope_key diferentes por construcao.
  constraint ck_extracao_scope_key_coerente check (
    (source_type = 'BORDERO'                  and scope_key like 'BORDERO=%') or
    (source_type = 'RELATORIO_TITULOS_ABERTO' and scope_key like 'PORTADOR=%')),
  -- coerencia: completude PARCIAL <-> estado PARCIAL
  constraint ck_extracao_estado_coerente check (
    (completude = 'PARCIAL' and estado = 'PARCIAL') or
    (completude = 'TOTAL'   and estado <> 'PARCIAL'))
);

create index if not exists ix_escopo_comparavel
  on public.extracao_escopo (source_type, scope_key, snapshot_at)
  where estado = 'TOTAL_VALIDADO';

comment on table public.extracao_escopo is
  'J3: uma linha por arquivo importado, com escopo e estado de validacao. '
  'Somente estado=TOTAL_VALIDADO pode ser usado para comparar ausencia. '
  'arquivo_hash e UNIQUE: reenviar o mesmo arquivo nao cria nova sequencia.';

-- ---------------------------------------------------------------------------
-- 2. PRESENÇA (append-only)
--
--    Grava SO presenca. Ausencia e calculo, nunca linha.
--    NORMALIZADO contra o desenho anterior:
--      · PK composta (escopo_id, documento) -> dispensa o bigserial e o
--                                   indice de PK separado
--      · importacao_id REMOVIDO  -> ja esta em extracao_escopo (1:1, unique)
--      · aluno_id       REMOVIDO -> derivavel por documento -> acordos_titulos
--                                   (titulos_sem_aluno_id = 0, medido)
--      · portador/bordero REMOVIDOS -> pertencem ao escopo, nao a linha
--      · linha_hash     REMOVIDO -> MEDIDO REDUNDANTE: (documento, valor,
--                                   vencimento, situacao, tipo_boleto) ja e
--                                   unico em 47.949/47.949 titulos. Guardar o
--                                   hash custaria 65 bytes/linha para repetir
--                                   informacao que as proprias colunas tem.
--      · created_at     REMOVIDO -> escopo.snapshot_at e escopo.created_at bastam
--    De ~270 para ~96 bytes/linha. Ver §10 do pacote.
-- ---------------------------------------------------------------------------
create table if not exists public.titulo_presenca_importacao (
  escopo_id          uuid not null references public.extracao_escopo(id),
  -- chave externa estavel. PROVADO em 2026-10-01: acordos_titulos.documento e
  -- unico em 47.949/47.949, 0 vazio, 0 colisao entre alunos.
  -- NAO usar CPF: 38,7% dos casos nao tem CPF valido e CPF nao identifica titulo.
  documento          text not null,
  -- CPF so quando o titulo e DESCONHECIDO do CRM; para os conhecidos o CPF ja
  -- existe em acordos_titulos/alunos e duplicar seria payload desnecessario.
  cpf_digitos        text,
  tipo_boleto_id     smallint references public.extracao_rotulo(id),
  situacao_id        smallint references public.extracao_rotulo(id),
  valor_observado    numeric(14,2),
  vencimento         date,
  -- chave sintetica do CRM (MANUAL-*): nunca aparece em extracao da ULBRA, logo
  -- nunca pode provar desaparecimento. Gravada para auditoria, excluida da view.
  chave_sintetica    boolean not null default false,
  -- PK (escopo_id, documento): escolhida depois de medir as duas ordens.
  -- Inverter para (documento, escopo_id) NAO economiza indice -- a view de
  -- observabilidade e as metricas do snapshot filtram por escopo_id, entao as
  -- duas ordens exigem dois indices. Com escopo_id na frente, a carga em lote
  -- de ~48 mil linhas fica contigua (range scan por extracao) em vez de
  -- aleatoria. Custo medido nesta base: PK ~76 B/linha + indice ~45 B/linha.
  constraint pk_titulo_presenca primary key (escopo_id, documento)
);

-- acesso dominante da view: "todas as extracoes deste documento".
create index if not exists ix_presenca_documento
  on public.titulo_presenca_importacao (documento);

comment on table public.titulo_presenca_importacao is
  'J3: uma linha por (extracao, documento) PRESENTE no arquivo bruto, capturada '
  'ANTES de qualquer filtro do importador (naoReabreNoBordero, PAGO, '
  'EM_CONFIRMACAO, CANCELADA). Representa o ARQUIVO RECEBIDO, nao o subconjunto '
  'processado. APPEND-ONLY. NUNCA grava ausencia nem escreve NEGOCIADO.';

-- ---------------------------------------------------------------------------
-- 3. APPEND-ONLY DE VERDADE
--    REVOKE sozinho nao basta (funcao SECURITY DEFINER passaria por cima), e o
--    default do schema public da arwdDxtm a authenticated -- inclusive TRUNCATE,
--    que RLS nao cobre. Padrao audit_log: authenticated = SELECT e nada mais.
-- ---------------------------------------------------------------------------
create or replace function public.tg_presenca_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'public.% e append-only: % recusado.', TG_TABLE_NAME, TG_OP
    using errcode = '42501';
end;
$$;

drop trigger if exists trg_presenca_append_only on public.titulo_presenca_importacao;
create trigger trg_presenca_append_only
  before update or delete on public.titulo_presenca_importacao
  for each row execute function public.tg_presenca_append_only();

drop trigger if exists trg_escopo_sem_delete on public.extracao_escopo;
create trigger trg_escopo_sem_delete
  before delete on public.extracao_escopo
  for each row execute function public.tg_presenca_append_only();

drop trigger if exists trg_rotulo_append_only on public.extracao_rotulo;
create trigger trg_rotulo_append_only
  before update or delete on public.extracao_rotulo
  for each row execute function public.tg_presenca_append_only();

-- extracao_escopo aceita UPDATE apenas nas colunas de validacao.
create or replace function public.tg_escopo_so_valida()
returns trigger language plpgsql as $$
begin
  if new.importacao_id  is distinct from old.importacao_id
  or new.source_type    is distinct from old.source_type
  or new.scope_key      is distinct from old.scope_key
  or new.completude     is distinct from old.completude
  or new.snapshot_at    is distinct from old.snapshot_at
  or new.arquivo_hash   is distinct from old.arquivo_hash
  or new.linhas_arquivo is distinct from old.linhas_arquivo then
    raise exception 'extracao_escopo: so as colunas de validacao podem mudar.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_escopo_so_valida on public.extracao_escopo;
create trigger trg_escopo_so_valida
  before update on public.extracao_escopo
  for each row execute function public.tg_escopo_so_valida();

alter table public.extracao_rotulo            enable row level security;
alter table public.extracao_escopo            enable row level security;
alter table public.titulo_presenca_importacao enable row level security;

revoke all on public.extracao_rotulo            from authenticated, anon, public;
revoke all on public.extracao_escopo            from authenticated, anon, public;
revoke all on public.titulo_presenca_importacao from authenticated, anon, public;
grant select on public.extracao_rotulo            to authenticated;
grant select on public.extracao_escopo            to authenticated;
grant select on public.titulo_presenca_importacao to authenticated;
revoke all on sequence public.extracao_rotulo_id_seq from authenticated, anon, public;

drop policy if exists p_rotulo_leitura on public.extracao_rotulo;
create policy p_rotulo_leitura on public.extracao_rotulo
  for select to authenticated using (public.usuario_e_gestao());
drop policy if exists p_escopo_leitura on public.extracao_escopo;
create policy p_escopo_leitura on public.extracao_escopo
  for select to authenticated using (public.usuario_e_gestao());
drop policy if exists p_presenca_leitura on public.titulo_presenca_importacao;
create policy p_presenca_leitura on public.titulo_presenca_importacao
  for select to authenticated using (public.usuario_e_gestao());

-- ---------------------------------------------------------------------------
-- 4. VALIDAÇÃO AUTOMÁTICA DO TOTAL
--    Faixas deliberadamente conservadoras: na duvida, PENDENTE. Um TOTAL
--    pendente nao bloqueia a importacao financeira -- so nao serve de prova.
-- ---------------------------------------------------------------------------
create or replace function public.extracao_avaliar_total(p_escopo_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_e    public.extracao_escopo;
  v_base public.extracao_escopo;
  v_m    jsonb := '{}'::jsonb;
  v_ok   boolean := true;
  -- ===================== LIMIARES — PROVISORIOS =====================
  -- CALIBRAVEIS, nao definitivos. Foram escolhidos por prudencia, sem
  -- distribuicao real medida: a base nao tem historico de snapshots TOTAL
  -- comparaveis (existe UM, de 31/08). Toda avaliacao grava as 4 variacoes em
  -- validacao_motivo -- inclusive quando APROVA -- para que
  -- vw_extracao_calibragem permita medir a distribuicao real depois e a gestao
  -- decidir. NUNCA sao ajustados automaticamente, e violacao SEMPRE vai para
  -- TOTAL_PENDENTE_VALIDACAO, jamais para TOTAL_VALIDADO.
  k_versao        text    := 'provisorio-2026-10-01';
  k_queda_linhas  numeric := 0.90;  -- minimo de 90% das linhas do ultimo TOTAL
  k_queda_titulos numeric := 0.90;  -- minimo de 90% dos titulos distintos
  k_queda_alunos  numeric := 0.90;  -- minimo de 90% dos alunos distintos
  k_queda_valor   numeric := 0.85;  -- minimo de 85% do valor (oscila mais)
  k_alta_linhas   numeric := 1.50;  -- maximo de 150% (acima = outro recorte)
  -- ==================================================================
begin
  select * into v_e from public.extracao_escopo where id = p_escopo_id;
  if v_e.id is null then raise exception 'Escopo % inexistente.', p_escopo_id; end if;
  if v_e.completude <> 'TOTAL' then
    return jsonb_build_object('estado','PARCIAL','motivo','declarado PARCIAL');
  end if;

  select * into v_base from public.extracao_escopo b
   where b.source_type = v_e.source_type
     and b.scope_key   = v_e.scope_key
     and b.estado      = 'TOTAL_VALIDADO'
     and b.snapshot_at < v_e.snapshot_at
   order by b.snapshot_at desc limit 1;

  if v_base.id is null then
    -- ============ REGRA DE BOOTSTRAP (item 3) ============
    -- O PRIMEIRO TOTAL de um escopo NUNCA e validado automaticamente. Nao ha
    -- snapshot anterior confiavel para comparar, e deixar a primeira extracao
    -- virar ancora sozinha seria aceitar como verdade o que ninguem conferiu --
    -- exatamente o erro que o J3 encontrou (um arquivo de 57 linhas e
    -- indistinguivel de um de 48 mil sem declaracao).
    -- So vira baseline depois de extracao_validar(...,'VALIDAR') pela gestao.
    -- =====================================================
    return jsonb_build_object('estado','TOTAL_PENDENTE_VALIDACAO',
      'regra','BOOTSTRAP',
      'motivo','primeiro TOTAL deste escopo -- sem baseline; exige validacao manual da gestao',
      'limiares_versao', k_versao,
      'metricas', jsonb_build_object('linhas', v_e.linhas_arquivo,
        'titulos', v_e.titulos_distintos, 'alunos', v_e.alunos_distintos,
        'valor', v_e.valor_total),
      'exige_validacao_humana', true);
  end if;

  v_m := jsonb_build_object(
    'regra','COMPARACAO_COM_BASELINE',
    'limiares_versao', k_versao,
    'limiares', jsonb_build_object('queda_linhas', k_queda_linhas,
      'queda_titulos', k_queda_titulos, 'queda_alunos', k_queda_alunos,
      'queda_valor', k_queda_valor, 'alta_linhas', k_alta_linhas),
    'baseline_id', v_base.id, 'baseline_snapshot_at', v_base.snapshot_at,
    'linhas',  jsonb_build_object('base', v_base.linhas_arquivo,    'novo', v_e.linhas_arquivo),
    'titulos', jsonb_build_object('base', v_base.titulos_distintos, 'novo', v_e.titulos_distintos),
    'alunos',  jsonb_build_object('base', v_base.alunos_distintos,  'novo', v_e.alunos_distintos),
    'valor',   jsonb_build_object('base', v_base.valor_total,       'novo', v_e.valor_total),
    'var_pct_linhas', case when coalesce(v_base.linhas_arquivo,0) > 0
      then round(100.0*(v_e.linhas_arquivo - v_base.linhas_arquivo)/v_base.linhas_arquivo, 2) end,
    'var_pct_valor',  case when coalesce(v_base.valor_total,0) > 0
      then round(100.0*(v_e.valor_total - v_base.valor_total)/v_base.valor_total, 2) end,
    'var_pct_titulos', case when coalesce(v_base.titulos_distintos,0) > 0
      then round(100.0*(v_e.titulos_distintos - v_base.titulos_distintos)/v_base.titulos_distintos, 2) end,
    'var_pct_alunos', case when coalesce(v_base.alunos_distintos,0) > 0
      then round(100.0*(v_e.alunos_distintos - v_base.alunos_distintos)/v_base.alunos_distintos, 2) end);

  if v_e.linhas_arquivo < k_queda_linhas * v_base.linhas_arquivo then
    v_ok := false; v_m := v_m || jsonb_build_object('falha_linhas', true); end if;
  if v_e.linhas_arquivo > k_alta_linhas * v_base.linhas_arquivo then
    v_ok := false; v_m := v_m || jsonb_build_object('falha_alta_linhas', true); end if;
  if coalesce(v_e.titulos_distintos,0) < k_queda_titulos * coalesce(v_base.titulos_distintos,0) then
    v_ok := false; v_m := v_m || jsonb_build_object('falha_titulos', true); end if;
  if coalesce(v_e.alunos_distintos,0) < k_queda_alunos * coalesce(v_base.alunos_distintos,0) then
    v_ok := false; v_m := v_m || jsonb_build_object('falha_alunos', true); end if;
  if coalesce(v_e.valor_total,0) < k_queda_valor * coalesce(v_base.valor_total,0) then
    v_ok := false; v_m := v_m || jsonb_build_object('falha_valor', true); end if;

  return v_m || jsonb_build_object(
    'estado', case when v_ok then 'TOTAL_VALIDADO' else 'TOTAL_PENDENTE_VALIDACAO' end,
    'exige_validacao_humana', not v_ok);
end;
$$;

-- Resolução manual pela gestão de um TOTAL pendente.
-- ============================================================================
-- ACL DA VALIDACAO MANUAL — DELIBERADAMENTE MAIS ESTRITA QUE O RESTO
--
-- Validar um TOTAL cria uma BASELINE, e baseline e o que no futuro podera
-- sustentar evidencia de ausencia. Por isso este ato NAO usa usuario_e_gestao()
-- -- que hoje libera 3 pessoas (amanda.seibel, cobranca04, cobranca07).
--
-- REUSA o padrao de autorizacao especifica da gerente que JA EXISTE no projeto:
-- app_pode_borderos_importacoes(), a ACL do proprio dominio de importacoes.
-- Nao ha e-mail hardcoded aqui -- se a identidade da gerencia mudar, muda em um
-- lugar so. A funcao tambem exige usuario ATIVO em public.usuarios.
--
-- Verificado em producao 2026-10-01:
--   amanda.seibel -> concede | cobranca04 -> NEGA | cobranca07 -> NEGA
--   (usuario_e_gestao() concederia aos tres -- por isso nao serve aqui)
--
-- Importar continua liberado a toda a gestao: so a PROMOCAO a baseline e restrita.
-- ============================================================================
create or replace function public.extracao_validar(
  p_escopo_id uuid, p_decisao text, p_motivo text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_estado text;
begin
  if not public.app_pode_borderos_importacoes() then
    raise exception 'Somente a gerencia pode validar um snapshot TOTAL: a validacao cria baseline.'
      using errcode = '42501';
  end if;
  if p_decisao not in ('VALIDAR','REPROVAR') then
    raise exception 'Decisão inválida: %', p_decisao using errcode = '22023';
  end if;
  v_estado := case p_decisao when 'VALIDAR' then 'TOTAL_VALIDADO'
                             else 'TOTAL_REPROVADO' end;
  update public.extracao_escopo
     set estado = v_estado,
         validado_por = coalesce(auth.jwt() ->> 'email','desconhecido'),
         validado_em  = now(),
         validacao_motivo = coalesce(validacao_motivo,'{}'::jsonb)
           || jsonb_build_object('decisao_humana', p_decisao, 'motivo_humano', p_motivo)
   where id = p_escopo_id and completude = 'TOTAL'
     and estado = 'TOTAL_PENDENTE_VALIDACAO';
  if not found then
    raise exception 'Escopo % não está em TOTAL_PENDENTE_VALIDACAO.', p_escopo_id
      using errcode = '22023';
  end if;
  return jsonb_build_object('escopo_id', p_escopo_id, 'estado', v_estado);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. RPC DE CAPTURA
--    Chamada DEPOIS do fluxo financeiro, em transacao propria. Se falhar, a
--    importacao financeira ja esta concluida e intacta -- nunca parcial.
--    Recebe as linhas do ARQUIVO BRUTO, antes de qualquer filtro.
-- ---------------------------------------------------------------------------
create or replace function public.registrar_presenca_extracao(
  p_importacao_id  uuid,
  p_source_type    text,
  p_scope_key      text,
  p_completude     text,        -- 'TOTAL' | 'PARCIAL'
  p_snapshot_at    timestamptz,
  p_arquivo_nome   text,
  p_arquivo_hash   text,
  p_linhas_arquivo integer,     -- TOTAL de linhas do arquivo
  p_linhas         jsonb        -- [{documento, cpf, tipo_boleto, situacao, valor, venc}]
) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  v_escopo_id uuid;
  v_grav int := 0;
  v_aval jsonb;
  v_estado text;
begin
  if not public.usuario_e_gestao() then
    raise exception 'Apenas a gestão pode registrar presença de extração.'
      using errcode = '42501';
  end if;
  if p_completude not in ('TOTAL','PARCIAL') then
    raise exception 'Completude inválida: %', p_completude using errcode = '22023';
  end if;
  if p_arquivo_hash is null or length(p_arquivo_hash) < 32 then
    raise exception 'arquivo_hash obrigatório (SHA-256).' using errcode = '22023';
  end if;

  -- IDEMPOTÊNCIA: mesmo arquivo reenviado devolve o escopo existente e NAO
  -- regrava nada -- nao cria sequencia nova nem falsa ausencia.
  select id into v_escopo_id from public.extracao_escopo
   where arquivo_hash = p_arquivo_hash;
  if v_escopo_id is not null then
    return jsonb_build_object('escopo_id', v_escopo_id, 'linhas_gravadas', 0,
                              'reaproveitado', true,
                              'estado', (select estado from public.extracao_escopo
                                          where id = v_escopo_id));
  end if;

  insert into public.extracao_escopo
    (importacao_id, source_type, scope_key, completude, estado, snapshot_at,
     arquivo_nome, arquivo_hash, linhas_arquivo, linhas_capturadas, declarado_por)
  values
    (p_importacao_id, p_source_type, p_scope_key, p_completude,
     case when p_completude = 'PARCIAL' then 'PARCIAL'
          else 'TOTAL_PENDENTE_VALIDACAO' end,          -- nunca nasce VALIDADO
     coalesce(p_snapshot_at, now()), p_arquivo_nome, p_arquivo_hash,
     coalesce(p_linhas_arquivo, 0),
     jsonb_array_length(coalesce(p_linhas,'[]'::jsonb)),
     coalesce(auth.jwt() ->> 'email','desconhecido'))
  returning id into v_escopo_id;

  with linha as (
    select
      nullif(btrim(x->>'documento'),'')                             as documento,
      nullif(regexp_replace(coalesce(x->>'cpf',''),'\D','','g'),'')  as cpf,
      nullif(btrim(x->>'tipo_boleto'),'')                            as tipo_boleto,
      nullif(btrim(x->>'situacao'),'')                               as situacao,
      nullif(x->>'valor','')::numeric                                as valor,
      nullif(x->>'venc','')::date                                    as venc
      from jsonb_array_elements(coalesce(p_linhas,'[]'::jsonb)) x
  ),
  dedup as (   -- mesmo documento 2x no arquivo: fica 1 linha (a de maior valor)
    select distinct on (documento) * from linha
     where documento is not null order by documento, valor desc nulls last
  )
  insert into public.titulo_presenca_importacao
    (escopo_id, documento, cpf_digitos, tipo_boleto_id, situacao_id,
     valor_observado, vencimento, chave_sintetica)
  select v_escopo_id, d.documento,
         -- CPF so quando o titulo e DESCONHECIDO do CRM (evita duplicar PII)
         case when exists (select 1 from public.acordos_titulos t
                            where t.documento = d.documento)
              then null else d.cpf end,
         public.extracao_rotulo_id('TIPO_BOLETO', d.tipo_boleto),
         public.extracao_rotulo_id('SITUACAO',    d.situacao),
         d.valor, d.venc,
         (d.documento !~ '^[0-9]{6,13}$')          -- MANUAL-* e afins
    from dedup d
  on conflict (escopo_id, documento) do nothing;

  get diagnostics v_grav = row_count;

  -- metricas do snapshot, para a validacao e a observabilidade
  update public.extracao_escopo e
     set linhas_capturadas = v_grav,
         titulos_distintos = (select count(*) from public.titulo_presenca_importacao p
                               where p.escopo_id = v_escopo_id and not p.chave_sintetica),
         alunos_distintos  = (select count(distinct coalesce(t.aluno_id::text, p.cpf_digitos))
                                from public.titulo_presenca_importacao p
                                left join public.acordos_titulos t on t.documento = p.documento
                               where p.escopo_id = v_escopo_id),
         valor_total       = (select round(coalesce(sum(p.valor_observado),0),2)
                                from public.titulo_presenca_importacao p
                               where p.escopo_id = v_escopo_id)
   where e.id = v_escopo_id;

  -- avalia e promove a TOTAL_VALIDADO so dentro das faixas
  v_aval := public.extracao_avaliar_total(v_escopo_id);
  v_estado := v_aval->>'estado';
  if v_estado = 'TOTAL_VALIDADO' then
    update public.extracao_escopo
       set estado = 'TOTAL_VALIDADO', validacao_motivo = v_aval,
           validado_por = 'automatico', validado_em = now()
     where id = v_escopo_id;
  else
    update public.extracao_escopo set validacao_motivo = v_aval
     where id = v_escopo_id;
  end if;

  return jsonb_build_object('escopo_id', v_escopo_id, 'linhas_gravadas', v_grav,
                            'reaproveitado', false,
                            'estado', (select estado from public.extracao_escopo
                                        where id = v_escopo_id),
                            'avaliacao', v_aval);
end;
$$;

revoke all on function public.registrar_presenca_extracao(
  uuid,text,text,text,timestamptz,text,text,integer,jsonb) from public, anon;
grant execute on function public.registrar_presenca_extracao(
  uuid,text,text,text,timestamptz,text,text,integer,jsonb) to authenticated;
revoke all on function public.extracao_validar(uuid,text,text) from public, anon;
grant execute on function public.extracao_validar(uuid,text,text) to authenticated;
revoke all on function public.extracao_avaliar_total(uuid) from public, anon;
revoke all on function public.extracao_rotulo_id(text,text) from public, anon;

-- ---------------------------------------------------------------------------
-- 6. VIEW DE HISTÓRICO — DIAGNÓSTICO APENAS
--    Compara SOMENTE TOTAL_VALIDADO -> TOTAL_VALIDADO do mesmo escopo.
--    Nunca TOTALxPARCIAL, PARCIALxPARCIAL, VALIDADOxPENDENTE, escopos distintos.
--    Separa ausencia INTERMEDIARIA (reaparecimento -> desqualifica) de
--    ausencia TERMINAL (unico padrao candidato).
-- ---------------------------------------------------------------------------
create or replace view public.vw_titulo_presenca_historico as
with comparavel as (
  select e.id, e.source_type, e.scope_key, e.snapshot_at,
         row_number() over (partition by e.source_type, e.scope_key
                            order by e.snapshot_at) as seq
    from public.extracao_escopo e
   where e.estado = 'TOTAL_VALIDADO'        -- <<< a trava central
),
presenca as (
  select p.documento, c.source_type, c.scope_key, c.seq, c.snapshot_at
    from public.titulo_presenca_importacao p
    join comparavel c on c.id = p.escopo_id
   where not p.chave_sintetica              -- exclui MANUAL-* da inferencia
),
janela as (
  select documento, source_type, scope_key,
         min(seq) as primeira_seq, max(seq) as ultima_seq,
         min(snapshot_at) as first_seen_at, max(snapshot_at) as last_seen_at,
         count(*) as extracoes_presente
    from presenca group by 1,2,3
),
grade as (
  select j.documento, j.source_type, j.scope_key, c.seq, c.snapshot_at,
         exists (select 1 from presenca p
                  where p.documento = j.documento and p.scope_key = j.scope_key
                    and p.source_type = j.source_type and p.seq = c.seq) as presente,
         (c.seq <= j.ultima_seq) as dentro_da_janela
    from janela j
    join comparavel c on c.source_type = j.source_type
                     and c.scope_key   = j.scope_key
                     and c.seq        >= j.primeira_seq
)
select j.documento,
       (select t.aluno_id from public.acordos_titulos t
         where t.documento = j.documento)                as aluno_id,
       j.source_type, j.scope_key,
       j.first_seen_at, j.last_seen_at, j.extracoes_presente,
       (select count(*) from grade g where g.documento = j.documento
         and g.scope_key = j.scope_key and g.source_type = j.source_type
         and not g.presente and g.dentro_da_janela)      as ausencias_intermediarias,
       (select count(*) from grade g where g.documento = j.documento
         and g.scope_key = j.scope_key and g.source_type = j.source_type
         and not g.presente and not g.dentro_da_janela)  as ausencias_consecutivas,
       (select min(g.snapshot_at) from grade g where g.documento = j.documento
         and g.scope_key = j.scope_key and g.source_type = j.source_type
         and not g.presente)                             as primeira_ausencia_observada,
       -- REAPARECIMENTO: desqualifica como prova deterministica nesta sequencia
       ((select count(*) from grade g where g.documento = j.documento
          and g.scope_key = j.scope_key and g.source_type = j.source_type
          and not g.presente and g.dentro_da_janela) > 0) as reapareceu_desqualifica,
       (j.ultima_seq = (select max(c2.seq) from comparavel c2
                         where c2.source_type = j.source_type
                           and c2.scope_key = j.scope_key)) as presente_na_ultima_extracao,
       (select count(*) from comparavel c3
         where c3.source_type = j.source_type
           and c3.scope_key = j.scope_key)               as extracoes_comparaveis_do_escopo
  from janela j;

comment on view public.vw_titulo_presenca_historico is
  'J3: historico de presenca/ausencia por titulo. DIAGNOSTICO APENAS -- nenhuma '
  'inferencia de vinculo esta implementada e ausencia NAO e prova de incorporacao '
  'a acordo (12 das 14 situacoes do §G do doc J3 invalidam). So compara '
  'TOTAL_VALIDADO x TOTAL_VALIDADO do mesmo escopo. reapareceu_desqualifica=true '
  'elimina o titulo como prova determinista naquela sequencia.';

-- ---------------------------------------------------------------------------
-- 7. OBSERVABILIDADE POR SNAPSHOT
-- ---------------------------------------------------------------------------
create or replace view public.vw_extracao_observabilidade as
select e.id, e.snapshot_at, e.created_at as recebido_em,
       e.arquivo_nome, e.arquivo_hash,
       e.source_type, e.scope_key, e.completude, e.estado,
       e.linhas_arquivo, e.linhas_capturadas,
       e.titulos_distintos, e.alunos_distintos, e.valor_total,
       b.id          as baseline_id,
       b.snapshot_at as baseline_snapshot_at,
       case when coalesce(b.linhas_arquivo,0) > 0
            then round(100.0*(e.linhas_arquivo - b.linhas_arquivo)/b.linhas_arquivo, 2)
       end as var_pct_linhas,
       case when coalesce(b.valor_total,0) > 0
            then round(100.0*(e.valor_total - b.valor_total)/b.valor_total, 2)
       end as var_pct_valor,
       (select count(*) from public.titulo_presenca_importacao n
         where n.escopo_id = e.id and not n.chave_sintetica
           and b.id is not null
           and not exists (select 1 from public.titulo_presenca_importacao a
                            where a.escopo_id = b.id and a.documento = n.documento)
       ) as novos_desde_baseline,
       (select count(*) from public.titulo_presenca_importacao a
         where a.escopo_id = b.id and not a.chave_sintetica
           and not exists (select 1 from public.titulo_presenca_importacao n
                            where n.escopo_id = e.id and n.documento = a.documento)
       ) as ausentes_desde_baseline,
       (select count(*) from public.vw_titulo_presenca_historico h
         where h.scope_key = e.scope_key and h.source_type = e.source_type
           and h.reapareceu_desqualifica) as reaparecimentos_no_escopo,
       e.validacao_motivo, e.validado_por, e.validado_em, e.declarado_por
  from public.extracao_escopo e
  left join lateral (
    select b2.* from public.extracao_escopo b2
     where b2.source_type = e.source_type and b2.scope_key = e.scope_key
       and b2.estado = 'TOTAL_VALIDADO' and b2.snapshot_at < e.snapshot_at
     order by b2.snapshot_at desc limit 1
  ) b on true;

comment on view public.vw_extracao_observabilidade is
  'J3: uma linha por extracao recebida, com variacao contra o ultimo '
  'TOTAL_VALIDADO do mesmo escopo e o estado de validacao. E aqui que um '
  'arquivo truncado declarado TOTAL aparece antes de virar prova.';

-- ---------------------------------------------------------------------------
-- 8. CALIBRAGEM DOS LIMIARES (item 2)
--    Existe para MEDIR, nunca para ajustar. Os limiares sao provisorios e so a
--    gestao os muda, por migration, depois de olhar esta distribuicao.
-- ---------------------------------------------------------------------------
create or replace view public.vw_extracao_calibragem as
select e.source_type, e.scope_key, e.snapshot_at, e.estado,
       e.validacao_motivo->>'limiares_versao'            as limiares_versao,
       e.validacao_motivo->>'regra'                      as regra,
       (e.validacao_motivo->>'var_pct_linhas')::numeric  as var_pct_linhas,
       (e.validacao_motivo->>'var_pct_titulos')::numeric as var_pct_titulos,
       (e.validacao_motivo->>'var_pct_alunos')::numeric  as var_pct_alunos,
       (e.validacao_motivo->>'var_pct_valor')::numeric   as var_pct_valor,
       coalesce((e.validacao_motivo->>'falha_linhas')::boolean,false)      as falhou_linhas,
       coalesce((e.validacao_motivo->>'falha_alta_linhas')::boolean,false) as falhou_alta,
       coalesce((e.validacao_motivo->>'falha_titulos')::boolean,false)     as falhou_titulos,
       coalesce((e.validacao_motivo->>'falha_alunos')::boolean,false)      as falhou_alunos,
       coalesce((e.validacao_motivo->>'falha_valor')::boolean,false)       as falhou_valor,
       e.validado_por, e.validado_em
  from public.extracao_escopo e
 where e.completude = 'TOTAL';

comment on view public.vw_extracao_calibragem is
  'J3: distribuicao real das variacoes entre snapshots TOTAL, para calibrar os '
  'limiares DEPOIS de ter historico. Os limiares sao provisorios (versao '
  'gravada em cada avaliacao) e NUNCA mudam automaticamente.';

-- ---------------------------------------------------------------------------
-- 9. TRILHA AUDITAVEL DE VALIDACAO (item 4)
--    Quem validou, quando, qual importacao, com que metricas e com que motivo.
-- ---------------------------------------------------------------------------
create or replace view public.vw_extracao_validacao_trilha as
select e.id                                        as escopo_id,
       e.importacao_id,
       i.arquivo_nome                              as importacao_arquivo,
       i.created_at                                as importacao_em,
       e.arquivo_nome, e.arquivo_hash,
       e.source_type, e.scope_key, e.completude, e.snapshot_at,
       e.estado,
       e.declarado_por,
       e.created_at                                as declarado_em,
       e.validado_por,
       e.validado_em,
       case when e.validado_por = 'automatico' then 'AUTOMATICA'
            when e.validado_por is not null    then 'MANUAL_GESTAO'
            else 'PENDENTE' end                    as natureza_da_validacao,
       e.validacao_motivo->>'decisao_humana'       as decisao_humana,
       e.validacao_motivo->>'motivo_humano'        as motivo_humano,
       e.linhas_arquivo, e.linhas_capturadas,
       e.titulos_distintos, e.alunos_distintos, e.valor_total,
       e.validacao_motivo                          as metricas_comparativas
  from public.extracao_escopo e
  left join public.importacoes i on i.id = e.importacao_id;

comment on view public.vw_extracao_validacao_trilha is
  'J3: trilha auditavel de quem declarou e quem validou cada extracao, com as '
  'metricas comparativas que embasaram a decisao. natureza_da_validacao '
  'distingue AUTOMATICA (dentro dos limiares) de MANUAL_GESTAO.';

-- (fim dos objetos -- sem `commit;`, ver nota no topo)

-- ============================================================================
-- ROLLBACK (nada a restaurar: objetos novos, nenhum DML em tabela existente)
-- ============================================================================
-- begin;
--   drop view     if exists public.vw_extracao_validacao_trilha;
--   drop view     if exists public.vw_extracao_calibragem;
--   drop view     if exists public.vw_extracao_observabilidade;
--   drop view     if exists public.vw_titulo_presenca_historico;
--   drop function if exists public.registrar_presenca_extracao(
--                   uuid,text,text,text,timestamptz,text,text,integer,jsonb);
--   drop function if exists public.extracao_validar(uuid,text,text);
--   drop function if exists public.extracao_avaliar_total(uuid);
--   drop trigger  if exists trg_presenca_append_only on public.titulo_presenca_importacao;
--   drop trigger  if exists trg_escopo_sem_delete    on public.extracao_escopo;
--   drop trigger  if exists trg_escopo_so_valida     on public.extracao_escopo;
--   drop trigger  if exists trg_rotulo_append_only   on public.extracao_rotulo;
--   drop table    if exists public.titulo_presenca_importacao;
--   drop table    if exists public.extracao_escopo;
--   drop function if exists public.extracao_rotulo_id(text,text);
--   drop table    if exists public.extracao_rotulo;
--   drop function if exists public.tg_escopo_so_valida();
--   drop function if exists public.tg_presenca_append_only();
-- commit;

-- ============================================================================
-- VALIDAÇÃO ANTES E DEPOIS — nenhuma linha pode mudar
-- ============================================================================
-- select count(*) as titulos, round(sum(coalesce(saldo_corrigido,0)),2) as saldo,
--        count(*) filter (where upper(coalesce(situacao,''))='ABERTO') as abertos,
--        count(*) filter (where upper(coalesce(situacao,''))='EM_CONFIRMACAO') as em_conf
--   from public.acordos_titulos;
-- select count(*) filter (where not coalesce(encerrado_operacional,false)) as em_fila,
--        count(*) as casos_total from public.casos;
-- select count(*) as vinculos_ativos from public.acordo_titulo_vinculo where coalesce(ativo,true);
-- select count(*) as acordos_ativos  from public.acordos where upper(coalesce(status,''))='ATIVO';
-- select round(sum(coalesce(saldo_total,0)),2) as alunos_saldo from public.alunos;
