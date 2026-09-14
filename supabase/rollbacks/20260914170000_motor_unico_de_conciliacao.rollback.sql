-- ROLLBACK de 20260914170000_motor_unico_de_conciliacao.sql
--
-- EXECUTAVEL DE PONTA A PONTA: roda inteiro, sem meta-comando de psql e sem
-- nenhum passo manual.
-- Os corpos completos das tres funcoes vigentes ANTES da migration estao aqui,
-- copiados dos arquivos onde cada uma foi definida pela ultima vez --
--
--   _pagamento_conciliar()              20260914140000_conciliacao_do_pagamento.sql
--                                       (em producao como 20260914125940)
--   baixa_pelo_relatorio_pagamento()    20260908200000_baixa_pelo_documento_respeita_vencimento.sql
--   pagamento_vincular_aluno()          ledger 20260912131102__origem_vinculo_prospectivo_em_pagamentos.sql
--
-- O QUE ESTE ROLLBACK NAO FAZ, DE PROPOSITO:
--   * nao desfaz baixa nenhuma. O que a migration acrescentou a escada so
--     RESTRINGE -- idempotencia, releitura sob o lock e amarracao fraca --
--     entao nada baixou por causa dela;
--   * nao apaga status_conciliacao, conciliacao_motivo nem origem_baixa.
--     Registro do que aconteceu nao se derruba para desfazer regra;
--   * nao reabre linha de fila ja decidida;
--   * nao mexe em `parcelas_amarrar_boleto` nem em `importar_acordos`, que a
--     migration nunca tocou.
--
-- ATENCAO: depois deste rollback volta o defeito que a migration corrigiu --
-- `baixa_pelo_relatorio_pagamento` baixa a parcela por fora e deixa
-- `status_conciliacao` velho, e a tela mostra pendencia falsa.

-- ---------------------------------------------------------------------------
-- 1. O gatilho do INSERT volta a ter a escada dentro dele
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- 2. `baixa_pelo_relatorio_pagamento` volta a ter regra propria
-- ---------------------------------------------------------------------------
-- Mesma assinatura de dois argumentos: e a que o `fluxo_pagamentos_rodar`
-- chama. Nenhuma sobrecarga e criada aqui, pelo mesmo motivo de la.

create or replace function public.baixa_pelo_relatorio_pagamento(p_confirmar boolean DEFAULT false, p_desde date DEFAULT '2026-07-01'::date)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '600s'
as $$
declare
  v_baixadas int := 0; v_alunos int := 0; v_registros int := 0;
  v_valor numeric := 0; v_lote text; v_menor int := 0; v_maior int := 0; v_recusadas int := 0;
begin
  if coalesce(current_setting('reativa.fluxo_pagamentos', true),'') <> 'on'
     and coalesce(auth.role(),'') <> 'service_role'
     and not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode='42501';
  end if;

  create temp table _brp_casa on commit drop as
  select distinct on (pa.id)
         p.id pagamento_id, a.aluno_id, pa.boleto chave, p.data_pagamento, p.valor_pago,
         coalesce(p.valor_honorario,0) honorario,
         coalesce(p.operador_email, p.operador_nome, 'extrato_santander') quem,
         nullif(p.operador_nome,'') op_nome, nullif(p.operador_email,'') op_email,
         pa.id parcela_id, pa.acordo_id, pa.valor,
         public.vencimento_do_pagamento(p.dados) venc_extrato
    from public.pagamentos p
    join public.parcelas pa on pa.boleto = ltrim(coalesce(p.numero_parcela_completo,''),'0')
    join public.acordos a on a.id = pa.acordo_id
   where p.data_pagamento >= p_desde
     and pa.status not in ('PAGO','CANCELADA')
     and upper(coalesce(a.status,'')) <> 'CANCELADO'
     and p.valor_pago >= pa.valor - 0.05
     and p.valor_pago <= pa.valor * 1.15
     and public.documento_casa_com_parcela(pa.id, public.vencimento_do_pagamento(p.dados))
   order by pa.id, p.data_pagamento;

  select count(*) filter (where p.valor_pago < pa.valor - 0.05),
         count(*) filter (where p.valor_pago > pa.valor * 1.15),
         count(*) filter (where p.valor_pago >= pa.valor - 0.05 and p.valor_pago <= pa.valor * 1.15
                            and not public.documento_casa_com_parcela(pa.id, public.vencimento_do_pagamento(p.dados)))
    into v_menor, v_maior, v_recusadas
    from public.pagamentos p
    join public.parcelas pa on pa.boleto = ltrim(coalesce(p.numero_parcela_completo,''),'0')
   where p.data_pagamento >= p_desde and pa.status not in ('PAGO','CANCELADA');

  select count(*), count(distinct aluno_id), round(coalesce(sum(valor_pago),0),2)
    into v_baixadas, v_alunos, v_valor from _brp_casa;

  if not coalesce(p_confirmar, false) then
    return jsonb_build_object('modo','previa','baixaria', v_baixadas,
      'alunos', v_alunos, 'valor', v_valor,
      'recusados_pagou_menos', v_menor, 'recusados_pagou_muito_mais', v_maior,
      'recusados_parcela_nao_bate', v_recusadas);
  end if;

  v_lote := 'baixa_relatorio_' || to_char(clock_timestamp(),'YYYYMMDDHH24MISS');
  execute format('create table if not exists public.%I as
       select p.*, now() salvo_em from public.parcelas p
        where p.id in (select parcela_id from _brp_casa)', '_backup_' || v_lote);
  execute format('alter table public.%I enable row level security', '_backup_' || v_lote);

  -- O REGISTRO DE BAIXA VEM ANTES da parcela: pagar a ultima parcela fecha o
  -- acordo na hora (trg_acordo_fecha_com_a_ultima_parcela), e acordo fechado
  -- recusa registro de baixa. Registrar primeiro evita a colisao entre as duas
  -- regras -- foi o que travou a baixa do Jean Batista Silva em 01/09.
  insert into public.baixas_pagamento
    (aluno_id, aluno_nome, aluno_cpf, valor_pago, honorarios_recebidos, status_baixa,
     operador_origem_nome, operador_origem_email, responsavel_baixa_nome, responsavel_baixa_email,
     baixado_por_nome, baixado_por_email, baixado_em, data_pagamento, parcela_id, acordo_id,
     observacao_operador)
  select al.id::text, al.nome, al.cpf, c.valor_pago, c.honorario, 'REALIZADA',
         coalesce(c.op_nome, al.responsavel_atual_nome), coalesce(c.op_email, al.responsavel_atual_email),
         coalesce(c.op_nome, al.responsavel_atual_nome), coalesce(c.op_email, al.responsavel_atual_email),
         'Rotina de baixa pelo documento', 'rotina@sistema', now(),
         c.data_pagamento, c.parcela_id, c.acordo_id, 'Baixa pelo documento ' || c.chave
    from _brp_casa c join public.alunos al on al.id = c.aluno_id
   where not exists (select 1 from public.baixas_pagamento b
                      where b.parcela_id = c.parcela_id and b.devolvido_em is null);
  get diagnostics v_registros = row_count;

  update public.parcelas pa
     set status = 'PAGO', pago_em = c.data_pagamento, confirmado_por_email = c.quem,
         honorarios = case when coalesce(pa.honorarios,0) = 0 and c.honorario > 0
                           then c.honorario else pa.honorarios end,
         observacao = coalesce(pa.observacao,'')
           || case when coalesce(pa.observacao,'')='' then '' else ' | ' end
           || 'baixa pelo documento ' || c.chave
           || ' pago em ' || to_char(c.data_pagamento,'DD/MM/YYYY')
           || case when c.venc_extrato is not null then ' (vencimento ' || to_char(c.venc_extrato,'DD/MM/YYYY') || ' conferido)' else '' end,
         atualizado_em = now()
    from _brp_casa c where pa.id = c.parcela_id and pa.status <> 'PAGO';
  get diagnostics v_baixadas = row_count;

  perform public.recalcular_situacao_aluno(x.aluno_id)
     from (select distinct aluno_id from _brp_casa) x;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (coalesce(nullif(auth.email(),''),'rotina'), 'BAIXA_PELO_DOCUMENTO', 'parcelas', null,
          jsonb_build_object('lote', v_lote, 'baixadas', v_baixadas, 'registros', v_registros,
                             'alunos', v_alunos, 'valor', v_valor, 'backup', '_backup_' || v_lote,
                             'recusados_parcela_nao_bate', v_recusadas));

  return jsonb_build_object('modo','aplicado','lote', v_lote,
    'parcelas_baixadas', v_baixadas, 'registros_de_baixa', v_registros,
    'alunos', v_alunos, 'valor', v_valor, 'backup', '_backup_' || v_lote,
    'recusados_pagou_menos', v_menor, 'recusados_pagou_muito_mais', v_maior,
    'recusados_parcela_nao_bate', v_recusadas);
end;
$$;
revoke all on function public.baixa_pelo_relatorio_pagamento(boolean, date) from public, anon;
grant execute on function public.baixa_pelo_relatorio_pagamento(boolean, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. `pagamento_vincular_aluno` volta a fechar a fila direto
-- ---------------------------------------------------------------------------

create or replace function public.pagamento_vincular_aluno(
  p_pagamento_id uuid, p_aluno_id uuid, p_observacao text default null
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare v_nome text; v_cpf text; v_ant uuid; v_email text; v_fila int := 0;
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Vincular pagamento a aluno e decisao da gestao.' using errcode = '42501';
  end if;

  v_email := coalesce(nullif(lower(auth.jwt() ->> 'email'),''), 'gestao');

  select a.nome, a.cpf into v_nome, v_cpf from public.alunos a where a.id = p_aluno_id;
  if v_nome is null then
    return jsonb_build_object('ok', false, 'motivo', 'ALUNO_NAO_ENCONTRADO');
  end if;

  select aluno_id into v_ant from public.pagamentos where id = p_pagamento_id;

  update public.pagamentos
     set aluno_id = p_aluno_id,
         cpf = coalesce(cpf, v_cpf),
         origem_vinculo = 'GESTAO_MANUAL',
         origem_vinculo_ref = v_email,
         origem_vinculo_em = now()
   where id = p_pagamento_id;

  -- fecha a pendencia na fila, se existir. Historico de quem resolveu fica aqui
  -- E em aluno_movimentacoes -- um para auditar a fila, outro para a ficha.
  update public.fila_pagamento_sem_vinculo
     set decisao = 'VINCULADO',
         aluno_escolhido_id = p_aluno_id,
         decidido_por = v_email,
         decidido_em = now(),
         observacao = p_observacao
   where pagamento_id = p_pagamento_id and decisao is null;
  get diagnostics v_fila = row_count;

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em)
  values (p_aluno_id::text, 'PAGAMENTO_VINCULADO',
          'Pagamento vinculado manualmente pela gestao.'
          || case when p_observacao is null then '' else ' ' || p_observacao end,
          v_email, v_email, now());

  return jsonb_build_object('ok', true, 'aluno_nome', v_nome,
                            'aluno_id_anterior', v_ant, 'fila_fechada', v_fila);
end;
$fn$;
grant execute on function public.pagamento_vincular_aluno(uuid, uuid, text) to authenticated;
revoke all on function public.pagamento_vincular_aluno(uuid, uuid, text) from public, anon;

-- ---------------------------------------------------------------------------
-- 4. O CHECK da fila volta aos tres valores originais
-- ---------------------------------------------------------------------------
--
-- Linhas ja gravadas com RESOLVIDO_AUTOMATICO ou ENCERRADO_GESTAO impediriam a
-- volta do CHECK estreito. Elas sao normalizadas para o valor original mais
-- proximo em SIGNIFICADO, e o rastro do que aconteceu fica na `observacao` --
-- que ja carrega o texto gravado pelo motor. Nenhuma linha e apagada.

update public.fila_pagamento_sem_vinculo
   set decisao = 'DESCARTADO',
       observacao = coalesce(observacao,'')
         || case when coalesce(observacao,'') = '' then '' else ' | ' end
         || 'decisao original: ' || decisao || ' (normalizada no rollback de 20260914170000)'
 where decisao in ('RESOLVIDO_AUTOMATICO','ENCERRADO_GESTAO');

do $ajuste$
declare v_con text;
begin
  select c.conname into v_con
    from pg_constraint c
   where c.conrelid = 'public.fila_pagamento_sem_vinculo'::regclass
     and c.contype = 'c'
     and pg_get_constraintdef(c.oid) ilike '%decisao%';

  if v_con is not null then
    execute format('alter table public.fila_pagamento_sem_vinculo drop constraint %I', v_con);
  end if;

  alter table public.fila_pagamento_sem_vinculo
    add constraint fila_pagamento_sem_vinculo_decisao_check
    check (decisao is null or decisao in ('VINCULADO','DESCARTADO','AGUARDANDO_TERCEIRO'));
end $ajuste$;

-- ---------------------------------------------------------------------------
-- 5. Sai o que a migration criou e ficaria chamavel sem uso
-- ---------------------------------------------------------------------------
-- `conciliacao_encerrar` tem EXECUTE para authenticated: sem o desenho novo ela
-- nao tem funcao e nao deve continuar exposta.

drop function if exists public.conciliacao_encerrar(uuid, text);

-- O motor e o reprocessador FICAM no banco, sem chamador e sem EXECUTE para
-- ninguem de fora. Recolocar o desenho passa a ser so recriar os chamadores --
-- e nenhum deles roda sozinho enquanto nao for recriado.
--   public.pagamento_conciliar_um(uuid, boolean)
--   public.conciliacao_reprocessar(boolean, int)

-- ---------------------------------------------------------------------------
-- 6. PROVA DO ROLLBACK
-- ---------------------------------------------------------------------------

do $prova$
declare v_n int;
begin
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='baixa_pelo_relatorio_pagamento';
  if v_n <> 1 then
    raise exception 'baixa_pelo_relatorio_pagamento ficou com % assinaturas', v_n;
  end if;

  if (select p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='baixa_pelo_relatorio_pagamento')
     not ilike '%update public.parcelas%' then
    raise exception 'baixa_pelo_relatorio_pagamento nao voltou a ter regra propria';
  end if;

  if (select p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='_pagamento_conciliar')
     not ilike '%update public.parcelas%' then
    raise exception 'o gatilho nao voltou a ter a escada dentro dele';
  end if;

  if exists (select 1 from pg_proc where proname='conciliacao_encerrar') then
    raise exception 'conciliacao_encerrar continua no banco';
  end if;

  if exists (select 1 from public.fila_pagamento_sem_vinculo
              where decisao in ('RESOLVIDO_AUTOMATICO','ENCERRADO_GESTAO')) then
    raise exception 'sobrou decisao fora do CHECK antigo';
  end if;
end $prova$;
