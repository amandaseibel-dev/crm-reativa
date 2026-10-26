-- AUDITORIA DO ENCERRAMENTO OPERACIONAL (26/10/2026).
--
-- POR QUE EXISTE. `casos.encerrado_operacional` tira o aluno da cobranca, das
-- filas e da contagem, e hoje muda sem deixar rastro: a tabela `casos` nao tem
-- coluna de data de encerramento, e o censo de 26/10/2026 achou ZERO registros
-- em `auditoria` para os 40 casos encerrados que estao na fila da Conferencia
-- Prime -- e UMA unica linha em `aluno_movimentacoes` entre os 7 que tinham
-- divida viva. Nao da para dizer quem encerrou, quando, nem por que.
--
-- VERSAO 20261026195000, e nao 20261026190000: a 190000 esta em colisao tripla
-- entre tres frentes nao mescladas (fix/encerramento-exige-saldo,
-- fix/p1-conferencia-prime-reentrada e fix/e7-atribuicao-remover). A catraca
-- nao pega isso: ela indexa so as versoes que JA EXISTEM no branch base, entao
-- duas branches podem introduzir a MESMA versao nova e cada uma passa sozinha.
-- 195000 foi conferida livre em todas as refs locais e no registro de producao.
--
-- Esta migration entra SOZINHA, antes da mudanca de regra
-- (20261026200000_encerramento_sem_saldo_validacao_financeira.sql,
-- a implementacao principal), de proposito: a
-- auditoria precisa estar no ar ANTES, para que a primeira alteracao de
-- encerramento provocada pela regra nova ja fique registrada.
--
-- ORIGEM. Desenhada e escrita na branch `fix/encerramento-exige-saldo` (SHA
-- 57e2de29), que a gestao encerrou para desenvolvimento em 26/10/2026 mantendo
-- esta implementacao como principal. Integrada aqui sem alterar a logica; as
-- duas correcoes abaixo sao de COMENTARIO, nao de comportamento, e vieram da
-- revisao feita nesta branch antes de commitar.
--
-- NAO INVENTA INFORMACAO AUSENTE. `usuario_email`, `usuario_role` e `motivo`
-- sao NULL quando o contexto nao os traz. Autor nulo e informacao ("mudou sem
-- contexto autenticado"); autor chutado seria mentira.
--
-- CORRECAO DE COMENTARIO 1: `origem` NAO fica nula. Sem a GUC
-- `reativa.encerramento_origem` ela cai em `'SESSION:' || session_user`, que e
-- sempre preenchido. A descricao anterior dizia o contrario.
--
-- CORRECAO DE COMENTARIO 2, declarando uma escolha de desenho que estava
-- implicita: `caso_id` NAO tem chave estrangeira para `casos`, de proposito. A
-- trilha sobrevive a exclusao do caso -- se tivesse FK com `on delete cascade`,
-- apagar o caso apagaria o registro de quem o encerrou, que e justamente o que
-- esta trilha existe para guardar. (A tabela `caso_encerramento_sem_saldo`, da
-- outra metade desta entrega, TEM a FK com cascade, e por isso precisou de uma
-- excecao no gatilho de imutabilidade para o cascade nao trancar o caso.)
--
-- PADRAO COPIADO de `trg_auditar_nao_acionar` / `casos_nao_acionar_auditoria`,
-- que ja esta em producao: AFTER, tabela propria, autoria em cascata por
-- `current_setting` -> `auth.jwt()` -> `caso_atualizado_por`, RLS ligada sem
-- policy e nenhum grant para `authenticated`.
--
-- NAO altera nenhum caso, nao encerra, nao reabre, nao lanca cobranca.

create table if not exists public.casos_encerramento_auditoria (
  id              bigint generated always as identity primary key,
  caso_id         uuid        not null,
  aluno_id        uuid,
  valor_anterior  boolean,
  valor_novo      boolean     not null,
  alterado_em     timestamptz not null default now(),
  operacao        text        not null,
  usuario_email   text,
  usuario_role    text,
  origem          text,
  motivo          text,
  metadados       jsonb
);

comment on table public.casos_encerramento_auditoria is
  'Trilha de casos.encerrado_operacional: valor anterior, valor novo, autor, origem, motivo e estado no instante. Campo ausente fica NULL -- nunca preenchido por inferencia.';

create index if not exists casos_encerramento_auditoria_caso_idx
  on public.casos_encerramento_auditoria (caso_id, alterado_em desc);
create index if not exists casos_encerramento_auditoria_aluno_idx
  on public.casos_encerramento_auditoria (aluno_id, alterado_em desc);

-- SEGURANCA. Trilha de auditoria nao e leitura de operador: `authenticated` nao
-- recebe nada, nem SELECT. Schema `public` concede `arwdDxtm` por default para
-- `authenticated` -- inclusive TRUNCATE, que RLS nao cobre --, por isso o
-- revoke e explicito e vem antes de ligar a RLS.
revoke all on public.casos_encerramento_auditoria from anon, authenticated;
alter table public.casos_encerramento_auditoria enable row level security;
-- Sem policy, de proposito: so `service_role` e `postgres` (que ignoram RLS)
-- leem a trilha. Mesma decisao de casos_nao_acionar_auditoria.

create or replace function public.trg_auditar_encerramento_operacional()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_ant boolean;
  v_saldo numeric;
  v_email text;
  v_role  text;
  v_uid   uuid;
begin
  -- INSERT so interessa quando o caso JA NASCE encerrado.
  if TG_OP = 'INSERT' then
    if not coalesce(NEW.encerrado_operacional, false) then return NEW; end if;
    v_ant := null;
  else
    if coalesce(NEW.encerrado_operacional,false) is not distinct from coalesce(OLD.encerrado_operacional,false)
      then return NEW; end if;
    v_ant := OLD.encerrado_operacional;
  end if;

  -- Saldo no instante da mudanca, para que a trilha permita conferir depois se
  -- o encerramento batia com a divida. Falha de calculo nao pode derrubar a
  -- transacao de quem estava atualizando o caso.
  begin
    v_saldo := (public.aluno_saldo_pendente_detalhe(NEW.aluno_id) ->> 'total')::numeric;
  exception when others then
    v_saldo := null;
  end;

  -- AUTOR, ROLE E UID TAMBEM DENTRO DE BLOCO PROTEGIDO. `auth.jwt()` faz cast
  -- de `request.jwt.claims` para jsonb e `auth.uid()` para uuid: com o GUC
  -- malformado, os dois LEVANTAM -- e este gatilho e `after insert or update`
  -- em `casos` sem clausula `when`, entao a excecao derrubaria QUALQUER escrita
  -- na tabela, inclusive rotina em lote. Ja houve precedente neste projeto de
  -- `jwt.claims` quebrar funcao. Sem contexto legivel, a trilha registra NULL e
  -- a transacao de quem atualiza o caso segue -- autor nulo e informacao.
  begin
    v_email := coalesce(nullif(btrim(current_setting('reativa.encerramento_usuario', true)),''),
                        nullif(btrim(auth.jwt() ->> 'email'),''),
                        nullif(btrim(NEW.caso_atualizado_por),''));
  exception when others then
    v_email := nullif(btrim(coalesce(current_setting('reativa.encerramento_usuario', true),
                                     NEW.caso_atualizado_por)),'');
  end;
  begin
    v_role := nullif(btrim(coalesce(auth.role(), '')),'');
  exception when others then
    v_role := null;
  end;
  begin
    v_uid := auth.uid();
  exception when others then
    v_uid := null;
  end;

  insert into public.casos_encerramento_auditoria
    (caso_id, aluno_id, valor_anterior, valor_novo, operacao,
     usuario_email, usuario_role, origem, motivo, metadados)
  values (
    NEW.id,
    NEW.aluno_id,
    v_ant,
    coalesce(NEW.encerrado_operacional,false),
    TG_OP,
    -- contexto autenticado quando existir; NUNCA inventa autor
    v_email,
    v_role,
    coalesce(nullif(btrim(current_setting('reativa.encerramento_origem', true)),''),
             'SESSION:' || session_user),
    nullif(btrim(current_setting('reativa.encerramento_motivo', true)),''),
    jsonb_build_object(
      'session_user',      session_user,
      'application_name',  nullif(btrim(current_setting('application_name', true)),''),
      'txid',              txid_current()::text,
      'auth_uid',          v_uid,
      -- os cinco campos que `caso_encerrado_operacional` le, para reconstruir
      -- qual deles justificou a marca
      'cpf_limpo_preenchido', nullif(regexp_replace(coalesce(NEW.cpf_limpo,''), '\D', '', 'g'), '') is not null,
      'status_atual',       NEW.status_atual,
      'status_acionamento', NEW.status_acionamento,
      'status_financeiro',  NEW.status_financeiro,
      'status_jornada',     NEW.status_jornada,
      'saldo_no_instante',  v_saldo,
      'nao_acionar',        coalesce(NEW.nao_acionar, false)
    )
  );
  return NEW;
end;
$function$;

-- `revoke ... from anon, authenticated` NAO FECHARIA NADA: o EXECUTE default de
-- funcao e concedido a PUBLIC, nao a esses dois papeis. Tem de ser `from
-- public`. A funcao e `security definer` e nao tem portao interno -- a protecao
-- e ser `returns trigger` (nao exposta pelo PostgREST, e falha fora do gatilho)
-- MAIS este revoke.
revoke all on function public.trg_auditar_encerramento_operacional() from public;
revoke all on function public.trg_auditar_encerramento_operacional() from anon, authenticated;

-- SEM `update of encerrado_operacional`, DE PROPOSITO -- e o teste provou por
-- que. `update of <coluna>` dispara pelas colunas NOMEADAS no comando, nao pelo
-- valor que mudou. E `encerrado_operacional` praticamente nunca e nomeada: quem
-- a escreve e o gatilho BEFORE `casos_set_encerrado_operacional`, a partir de
-- `update casos set status_atual = ...`. Com a clausula `OF`, a auditoria
-- perderia quase toda mudanca real -- que e o oposto do que ela existe para
-- fazer. (O `trg_auditar_nao_acionar` pode usar `OF` porque `nao_acionar` e
-- escrita diretamente por quem decide.)
--
-- O filtro fica na funcao, que sai na primeira linha quando o valor nao mudou.
drop trigger if exists trg_auditar_encerramento_operacional on public.casos;
create trigger trg_auditar_encerramento_operacional
  after insert or update on public.casos
  for each row execute function public.trg_auditar_encerramento_operacional();
