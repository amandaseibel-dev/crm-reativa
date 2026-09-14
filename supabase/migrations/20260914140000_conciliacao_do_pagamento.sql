-- CONCILIACAO DO PAGAMENTO: o fim dos `return new` mudos.
--
-- O QUE ESTAVA ERRADO. `_pagamento_baixa_pelo_documento` tem SEIS saidas sem
-- baixa. Cinco delas sao um `return new` mudo:
--
--   a linha nao trouxe boleto ............. return new   (mudo)
--   boleto nao existe em parcelas ......... return new   (mudo)
--   parcela.status = 'PAGO' ............... return new   (mudo)
--   acordo nao e ATIVO .................... return new   (mudo)
--   valor fora da faixa [-0,05 ; +15%] .... return new   (mudo)
--   vencimento nao bate (+-3 dias) ........ grava em `auditoria`, return new
--
-- O dinheiro entra -- e entra certo, porque a projecao le `pagamentos` e nao
-- depende de baixa nenhuma. Mas a parcela nao baixa e nao fica registro de por
-- que. E a `fila_pagamento_sem_vinculo` nao cobre esse buraco porque enfileira
-- por `aluno_id IS NULL`: eixo errado. Ela responde "de quem e o dinheiro", nao
-- "a parcela foi baixada".
--
-- MEDIDO no arquivo Santander de 14/09/2026 (76 linhas, R$ 45.209,20):
--   44 barradas antes do INSERT (duplicata ja no banco)
--    9 baixariam                              R$  3.623,98
--   11 sem acordo no CRM                      R$  6.233,40   -> aluno_id NULO, ja aparecem na fila
--    7 acordo existe, parcela sem boleto      R$  3.739,63   -> aluno_id RESOLVIDO, INVISIVEIS
--    1 vencimento nao bate                    R$    419,74   -> so em `auditoria`
--    4 parcela ja PAGO                        R$    915,49   -> aluno_id RESOLVIDO, INVISIVEIS
--   As 7 + as 4 = 11 linhas / R$ 4.655,12 entrariam hoje sem registro nenhum.
--
-- O QUE ESTA MIGRATION FAZ, E SO ISSO:
--   1. `pagamentos` ganha status_conciliacao / conciliacao_motivo / conciliacao_em;
--   2. os DOIS gatilhos AFTER INSERT viram UM SO, para que o estado e a fila
--      nunca possam discordar por ordem de execucao;
--   3. a fila passa a enfileirar por "nao baixou", e nao por "sem aluno";
--   4. `pagamentos_sem_aluno` devolve o estado e o motivo.
--
-- O QUE ELA NAO FAZ. Nao toca `projecao_snapshot_gerar`, nem o calculo da
-- projecao, nem a deduplicacao de `projecao_importar_pagamentos`, nem a
-- atribuicao de operador. E, o mais importante: NAO MUDA NENHUMA CONDICAO QUE
-- AUTORIZA A BAIXA. A escada abaixo e copia literal da VERSAO VIGENTE em
-- producao -- supabase/ledger/2026-09/20260912121649__fase2b_origem_baixa_no_
-- gatilho_e_invariante_novo.sql, de 12/09/2026, que substituiu a de 08/09 e
-- acrescentou os tres carimbos de origem_baixa ao UPDATE -- mesmas
-- comparacoes, mesma ordem, mesmo `v_parcela.status = 'PAGO'` sem upper(),
-- mesma faixa de valor, mesma guarda de vencimento, mesmo registro em
-- `auditoria`, mesmo UPDATE (inclusive origem_baixa / origem_baixa_ref /
-- origem_baixa_em, que o vigia `baixa_sem_evidencia_de_quem_baixou` le como
-- prova de autoria da baixa), mesmo recalcular_situacao_aluno. O teste
-- supabase/tests/conciliacao_pagamento.test.js extrai as condicoes dos DOIS
-- arquivos e falha se divergirem.
--
-- PROSPECTIVO. Os pagamentos historicos ficam com status_conciliacao NULL, de
-- proposito -- o CHECK aceita NULL exatamente para isso. Preencher por
-- inferencia seria inventar prova, como ja foi decidido em `origem_vinculo`.

-- 1. O ESTADO ------------------------------------------------------------

alter table public.pagamentos
  add column if not exists status_conciliacao text,
  add column if not exists conciliacao_motivo text,
  add column if not exists conciliacao_em     timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pagamentos_status_conciliacao_valido') then
    alter table public.pagamentos
      add constraint pagamentos_status_conciliacao_valido check (
        status_conciliacao is null or status_conciliacao in (
          'BAIXADO',               -- a parcela do boleto foi baixada nesta insercao
          'AGUARDANDO_ACORDO',     -- boleto valido, mas o acordo nao esta no CRM
          'AGUARDANDO_AMARRACAO',  -- o acordo existe e tem parcela livre, sem boleto
          'PARCELA_JA_PAGA',       -- a parcela do boleto ja estava PAGO
          'REVISAO',               -- divergencia: vencimento, valor ou acordo nao ATIVO
          'SEM_VINCULO'            -- a linha nao trouxe boleto utilizavel
        )
      );
  end if;
end $$;

comment on column public.pagamentos.status_conciliacao is
  'Desfecho da conciliacao da parcela, decidido na insercao. Prospectivo a partir de 14/09/2026 -- NULL no historico, de proposito. Nao tem estado "ja importado": linha ja importada e barrada ANTES do INSERT e nao chega a existir aqui.';
comment on column public.pagamentos.conciliacao_motivo is
  'Por que nao houve baixa, em texto, para a fila operacional. NULL quando status_conciliacao = BAIXADO.';
comment on column public.pagamentos.conciliacao_em is
  'Quando a conciliacao foi decidida.';

create index if not exists ix_pagamentos_conciliacao_pendente
  on public.pagamentos (status_conciliacao, data_pagamento desc)
  where status_conciliacao is not null and status_conciliacao <> 'BAIXADO';

-- 2. A FILA PASSA A CARREGAR O ESTADO ------------------------------------

alter table public.fila_pagamento_sem_vinculo
  add column if not exists status_conciliacao text;

comment on column public.fila_pagamento_sem_vinculo.status_conciliacao is
  'Copia do desfecho gravado em pagamentos, para a fila filtrar sem join. Escrita na MESMA chamada de gatilho que grava o estado -- as duas nunca divergem.';

comment on table public.fila_pagamento_sem_vinculo is
  'Pagamento gravado que NAO teve baixa de parcela -- por falta de vinculo, de acordo, de amarracao, ou por divergencia. Ate 14/09/2026 esta fila so recebia linha sem aluno; hoje recebe todo pagamento cuja conciliacao nao terminou em BAIXADO. Nome nunca vincula: aparece so como sugestao. Nenhum pagamento e descartado.';

-- 3. UM GATILHO SO -------------------------------------------------------
--
-- POR QUE UM SO, E NAO DOIS AFTER INSERT. Hoje sao dois -- `trg_pagamento_-
-- baixa_documento` e `trg_pagamento_enfileira_sem_vinculo` -- e o PostgreSQL
-- dispara AFTER ROW em ordem ALFABETICA do nome do gatilho. "baixa" < "enfileira"
-- por acidente do alfabeto, entao hoje a baixa roda antes. Renomear qualquer um
-- dos dois inverteria a ordem em silencio e a fila passaria a enfileirar contra
-- um estado que ainda nao foi decidido. Estado e fila escritos pela MESMA
-- chamada de funcao nao tem como discordar -- nao ha ordem entre eles.
--
-- Por que AFTER e nao BEFORE. A baixa continua exatamente onde estava. Alem
-- disso a fila referencia pagamentos(id) com FK nao adiavel: enfileirar antes
-- do INSERT violaria a FK. E, num INSERT de varias linhas, os AFTER ROW rodam
-- um a um ja enxergando o efeito do anterior -- entao dois pagamentos para a
-- MESMA parcela no mesmo arquivo dao BAIXADO e depois PARCELA_JA_PAGA, que e o
-- certo. Decidir no BEFORE daria BAIXADO nos dois, porque todos os BEFORE rodam
-- antes de qualquer AFTER.
--
-- O preco: gravar o estado exige um UPDATE da propria linha recem-inserida, e
-- esse UPDATE dispara `trg_audit`. Uma linha de auditoria por pagamento. Os
-- outros dois BEFORE (`trg_pagamento_matricula`, `trg_pagamento_nome_do_-
-- operador`) sao `UPDATE OF dados` / `UPDATE OF operador_email, operador_nome`
-- e nao disparam: nenhuma dessas colunas esta no SET.

create or replace function public._pagamento_conciliar()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_chave text; v_parcela record; v_venc date; v_pref text;
  v_status text; v_motivo text;
  v_acordos int := 0; v_livres int := 0;
  v_sug jsonb := '[]'::jsonb; v_arq text;
begin
  v_chave := ltrim(coalesce(new.numero_parcela_completo,''),'0');
  v_venc  := public.vencimento_do_pagamento(new.dados);

  -- ------------------------------------------------------------------
  -- A ESCADA DA BAIXA. Copia literal de 20260908200000. Nenhuma condicao
  -- nova, nenhuma condicao afrouxada. A unica diferenca e que cada saida
  -- agora diz o seu nome em vez de sair calada.
  -- ------------------------------------------------------------------
  if v_chave = '' then
    v_status := 'SEM_VINCULO';
    v_motivo := 'a linha do arquivo nao trouxe numero de boleto';
  else
    select p.id, p.valor, p.status, p.honorarios, p.acordo_id, p.vencimento, p.numero,
           a.aluno_id, a.status status_acordo
      into v_parcela
      from public.parcelas p join public.acordos a on a.id = p.acordo_id
     where p.boleto = v_chave limit 1;

    if not found then
      -- Nao ha parcela com esse boleto. A classificacao abaixo e SOMENTE
      -- LEITURA e nao autoriza baixa nenhuma: serve para a fila dizer o que
      -- falta -- o acordo, ou a amarracao do boleto.
      if length(coalesce(new.numero_parcela_completo,'')) = 11 then
        v_pref := substring(new.numero_parcela_completo, 2, 6);

        select count(*) into v_acordos
          from public.acordos a
         where a.numero_ulbra is not null
           and lpad(a.numero_ulbra, 6, '0') = v_pref
           and upper(coalesce(a.status,'')) <> 'CANCELADO';

        select count(*) into v_livres
          from public.acordos a join public.parcelas p on p.acordo_id = a.id
         where a.numero_ulbra is not null
           and lpad(a.numero_ulbra, 6, '0') = v_pref
           and upper(coalesce(a.status,'')) <> 'CANCELADO'
           and p.boleto is null
           and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA');

        if v_acordos = 0 then
          v_status := 'AGUARDANDO_ACORDO';
          v_motivo := 'boleto ' || new.numero_parcela_completo
            || ' nao existe em parcelas e o acordo ' || v_pref || ' nao esta no CRM';
        elsif v_livres > 0 then
          v_status := 'AGUARDANDO_AMARRACAO';
          v_motivo := 'o acordo ' || v_pref || ' esta no CRM com ' || v_livres
            || ' parcela(s) sem boleto: falta amarrar o boleto '
            || new.numero_parcela_completo || ' a parcela certa';
        else
          v_status := 'REVISAO';
          v_motivo := 'o acordo ' || v_pref
            || ' esta no CRM e nao tem parcela livre para receber o boleto '
            || new.numero_parcela_completo;
        end if;
      else
        v_status := 'SEM_VINCULO';
        v_motivo := 'boleto fora do padrao de 11 digitos: ' || new.numero_parcela_completo;
      end if;

    elsif v_parcela.status = 'PAGO' then
      v_status := 'PARCELA_JA_PAGA';
      v_motivo := 'a parcela ' || coalesce(v_parcela.numero::text,'?') || ' do boleto '
        || v_chave || ' ja estava PAGO antes deste pagamento entrar: conferir se e'
        || ' segunda via, pagamento em duplicidade ou baixa anterior por outro caminho';

    elsif upper(coalesce(v_parcela.status_acordo,'')) <> 'ATIVO' then
      v_status := 'REVISAO';
      v_motivo := 'o acordo do boleto ' || v_chave || ' esta '
        || upper(coalesce(v_parcela.status_acordo,'(sem status)')) || ', nao ATIVO';

    elsif new.valor_pago < v_parcela.valor - 0.05
       or new.valor_pago > v_parcela.valor * 1.15 then
      v_status := 'REVISAO';
      v_motivo := 'valor pago ' || to_char(new.valor_pago,'FM999G999G990D00')
        || ' fora da faixa aceita para a parcela de '
        || to_char(v_parcela.valor,'FM999G999G990D00')
        || ' (de -R$ 0,05 ate +15%)';

    elsif not public.documento_casa_com_parcela(v_parcela.id, v_venc) then
      -- O registro em `auditoria` continua igual: e o que a Conferencia de
      -- Pagamentos ja le desde 08/09. A fila passa a ver o mesmo caso.
      insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
      values ('rotina', 'BAIXA_DOCUMENTO_RECUSADA', 'parcelas', v_parcela.id,
              jsonb_build_object('pagamento_id', new.id, 'documento', v_chave,
                                 'vencimento_extrato', v_venc, 'parcela_numero', v_parcela.numero,
                                 'parcela_vencimento', v_parcela.vencimento, 'valor_pago', new.valor_pago,
                                 'motivo', case when v_venc is not null then 'vencimento do extrato nao bate com a parcela do boleto'
                                                else 'ha parcela mais antiga em aberto no acordo' end));
      v_status := 'REVISAO';
      v_motivo := case when v_venc is not null
        then 'vencimento do arquivo (' || to_char(v_venc,'DD/MM/YYYY')
             || ') nao bate com a parcela ' || coalesce(v_parcela.numero::text,'?')
             || ' do boleto, que vence ' || to_char(v_parcela.vencimento,'DD/MM/YYYY')
        else 'ha parcela mais antiga em aberto no acordo: o boleto ' || v_chave
             || ' nao pode baixar a parcela ' || coalesce(v_parcela.numero::text,'?') end;

    else
      update public.parcelas
         set status = 'PAGO', pago_em = new.data_pagamento,
             confirmado_por_email = coalesce(new.operador_email,'extrato_santander'),
             -- NOVO: a origem fica explicita, com o evento que a gerou.
             origem_baixa = 'GATILHO_IMPORTACAO',
             origem_baixa_ref = new.id::text,
             origem_baixa_em = now(),
             honorarios = case when coalesce(honorarios,0) = 0 and coalesce(new.valor_honorario,0) > 0
                               then new.valor_honorario else honorarios end,
             observacao = coalesce(observacao,'')
               || case when coalesce(observacao,'') = '' then '' else ' | ' end
               || 'baixa automatica na importacao: documento ' || v_chave
               || ' pago em ' || to_char(new.data_pagamento,'DD/MM/YYYY')
               || case when v_venc is not null then ' (vencimento ' || to_char(v_venc,'DD/MM/YYYY') || ' conferido)' else '' end,
             atualizado_em = now()
       where id = v_parcela.id;

      perform public.recalcular_situacao_aluno(v_parcela.aluno_id);
      v_status := 'BAIXADO';
      v_motivo := null;
    end if;
  end if;

  -- ------------------------------------------------------------------
  -- O ESTADO. Mesma chamada de funcao que a fila abaixo: nao ha janela em
  -- que um exista sem o outro.
  -- ------------------------------------------------------------------
  update public.pagamentos
     set status_conciliacao = v_status,
         conciliacao_motivo = v_motivo,
         conciliacao_em     = now()
   where id = new.id;

  if v_status = 'BAIXADO' then
    return null;
  end if;

  -- ------------------------------------------------------------------
  -- A FILA. Eixo novo: entra tudo que nao baixou, com ou sem aluno.
  -- As sugestoes por nome so fazem sentido quando o aluno ainda e desconhecido
  -- -- e continuam sendo SUGESTAO, nunca aplicadas.
  -- ------------------------------------------------------------------
  if new.aluno_id is null and coalesce(trim(new.aluno_nome),'') <> '' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'aluno_id', a.id, 'nome', a.nome, 'cpf_mascarado', a.cpf_mascarado,
             'matricula', a.matricula, 'tem_acordo_ativo',
             exists (select 1 from public.acordos ac where ac.aluno_id = a.id and ac.status='ATIVO'))), '[]'::jsonb)
      into v_sug
      from public.alunos a
     where coalesce(trim(a.nome),'') <> ''
       and translate(upper(regexp_replace(trim(a.nome), '\s+', ' ', 'g')),
                     'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC')
         = translate(upper(regexp_replace(trim(new.aluno_nome), '\s+', ' ', 'g')),
                     'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC');
  end if;

  select i.arquivo_nome into v_arq from public.importacoes i where i.id = new.importacao_id;

  insert into public.fila_pagamento_sem_vinculo
    (pagamento_id, importacao_id, arquivo_nome, boleto, data_pagamento, valor_pago,
     valor_honorario, nome_recebido, cpf_recebido, matricula_recebida, sugestoes,
     motivo, status_conciliacao)
  values (new.id, new.importacao_id, v_arq, new.numero_parcela_completo, new.data_pagamento,
          new.valor_pago, new.valor_honorario, new.aluno_nome, new.cpf, new.matricula, v_sug,
          v_motivo || case when jsonb_array_length(v_sug) > 0
                           then ' | ' || jsonb_array_length(v_sug)::text || ' sugestao(oes) por nome, para conferencia humana'
                           else '' end,
          v_status)
  on conflict (pagamento_id) do nothing;

  return null;
end;
$fn$;

revoke all on function public._pagamento_conciliar() from public, anon, authenticated;

-- 4. A TROCA. Os dois gatilhos saem; as duas funcoes antigas ficam no banco
-- para rollback, como foi feito em 20260912121224.

drop trigger if exists trg_pagamento_baixa_documento     on public.pagamentos;
drop trigger if exists trg_pagamento_enfileira_sem_vinculo on public.pagamentos;

create trigger trg_pagamento_conciliar
  after insert on public.pagamentos
  for each row execute function public._pagamento_conciliar();

-- 5. A FILA OPERACIONAL PASSA A ENXERGAR QUEM TEM ALUNO E NAO BAIXOU --------
--
-- Muda o WHERE e acrescenta duas colunas. O portao de gestao, os grants, o
-- motivo por nome, as sugestoes e a opcao "qualquer mes" ficam como estao.
-- Linha historica (aluno_id nulo, anterior a 12/09) continua aparecendo.

drop function if exists public.pagamentos_sem_aluno(text, boolean);

create or replace function public.pagamentos_sem_aluno(
  p_mes text default null,
  p_todos_os_meses boolean default false
)
returns table (
  pagamento_id uuid,
  data_pagamento date,
  aluno_nome text,
  matricula text,
  titulo_numero text,
  numero_parcela_completo text,
  valor_pago numeric,
  valor_honorario numeric,
  operador_nome text,
  operador_email text,
  motivo text,
  candidatos integer,
  motivo_financeiro text,
  sugestoes jsonb,
  detectado_em timestamptz,
  importacao_id uuid,
  arquivo_nome text,
  -- NOVO
  status_conciliacao text,
  tem_aluno boolean
)
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'A fila de pagamentos sem vinculo e da gestao financeira.' using errcode = '42501';
  end if;

  return query
  with mes as (
    select coalesce(p_mes, to_char(now() at time zone 'America/Sao_Paulo', 'YYYY-MM')) as m
  )
  select
    p.id, p.data_pagamento, p.aluno_nome, p.matricula,
    p.titulo_numero, p.numero_parcela_completo,
    p.valor_pago, p.valor_honorario,
    p.operador_nome, p.operador_email,
    case when c.qtd > 1 then 'NOME_REPETIDO' else 'SEM_CADASTRO' end::text,
    coalesce(c.qtd, 0)::int,
    -- Preferir o motivo da conciliacao, que e o novo e o mais especifico;
    -- cair para o motivo da fila; e so entao dizer que a linha e anterior.
    coalesce(p.conciliacao_motivo, f.motivo,
             'entrou antes da regra de identificador financeiro (12/09/2026)')::text,
    coalesce(f.sugestoes, '[]'::jsonb),
    f.detectado_em,
    p.importacao_id,
    i.arquivo_nome,
    p.status_conciliacao,
    (p.aluno_id is not null)
  from public.pagamentos p
  cross join mes
  left join lateral (
    select count(*)::int as qtd from public.alunos a
     where upper(trim(a.nome)) = upper(trim(coalesce(p.aluno_nome,'')))
       and coalesce(trim(p.aluno_nome),'') <> ''
  ) c on true
  left join public.fila_pagamento_sem_vinculo f
    on f.pagamento_id = p.id and f.decisao is null
  left join public.importacoes i on i.id = p.importacao_id
  where (p.aluno_id is null or f.pagamento_id is not null)
    and (coalesce(p_todos_os_meses, false)
         or to_char(p.data_pagamento, 'YYYY-MM') = mes.m)
  order by p.data_pagamento desc, p.valor_pago desc;
end;
$fn$;

grant execute on function public.pagamentos_sem_aluno(text, boolean) to authenticated;
revoke all on function public.pagamentos_sem_aluno(text, boolean) from public, anon;

-- 6. PROVA ---------------------------------------------------------------

do $$
declare
  v_n int; v_auth boolean; v_anon boolean; v_portao boolean;
begin
  -- um unico AFTER INSERT de conciliacao, e os dois antigos fora
  select count(*) into v_n from pg_trigger t
   where t.tgrelid = 'public.pagamentos'::regclass and not t.tgisinternal
     and t.tgname in ('trg_pagamento_baixa_documento','trg_pagamento_enfileira_sem_vinculo');
  if v_n <> 0 then
    raise exception 'os gatilhos antigos continuam na tabela: a ordem alfabetica voltaria a decidir';
  end if;

  select count(*) into v_n from pg_trigger t
   where t.tgrelid = 'public.pagamentos'::regclass and t.tgname = 'trg_pagamento_conciliar';
  if v_n <> 1 then
    raise exception 'trg_pagamento_conciliar nao ficou exatamente uma vez';
  end if;

  -- as funcoes antigas continuam no banco, para rollback
  if not exists (select 1 from pg_proc where proname = '_pagamento_baixa_pelo_documento') then
    raise exception 'a funcao antiga de baixa sumiu: o rollback ficaria sem volta';
  end if;

  -- o gatilho de vinculo (BEFORE) nao foi tocado
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.pagamentos'::regclass
                    and tgname = 'trg_pagamento_vincula_identificador') then
    raise exception 'o gatilho de vinculo por identificador financeiro sumiu';
  end if;

  -- a fila tem de carregar o estado: sem esta coluna a tela precisaria de join
  -- e voltaria a poder ler um estado diferente do que foi decidido.
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public'
                    and table_name = 'fila_pagamento_sem_vinculo'
                    and column_name = 'status_conciliacao') then
    raise exception 'a fila ficou sem status_conciliacao';
  end if;

  select has_function_privilege('authenticated', p.oid, 'EXECUTE'),
         has_function_privilege('anon', p.oid, 'EXECUTE'),
         p.prosrc like '%usuario_e_gestao%'
    into v_auth, v_anon, v_portao
    from pg_proc p where p.proname = 'pagamentos_sem_aluno';
  if not v_auth then raise exception 'pagamentos_sem_aluno sem EXECUTE para authenticated -- a tela quebraria'; end if;
  if v_anon then raise exception 'pagamentos_sem_aluno aberta para anon'; end if;
  if not v_portao then raise exception 'pagamentos_sem_aluno sem portao interno de gestao'; end if;
  if (select count(*) from pg_proc where proname = 'pagamentos_sem_aluno') <> 1 then
    raise exception 'sobrou mais de uma assinatura de pagamentos_sem_aluno';
  end if;

  if has_function_privilege('authenticated', 'public._pagamento_conciliar()'::regprocedure, 'EXECUTE') then
    raise exception '_pagamento_conciliar ficou chamavel por authenticated';
  end if;
end $$;
