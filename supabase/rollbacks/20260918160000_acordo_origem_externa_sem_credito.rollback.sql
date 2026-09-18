-- ROLLBACK de 20260918160000_acordo_origem_externa_sem_credito.sql
-- Devolve os corpos de producao de 18/09/2026 (previa ad10fff9, registrador
-- 2613270d, heranca 054ac6e1) e remove a funcao e a tabela de autorizacao.
-- O acordo registrado sem credito continua como esta (responsavel nulo); a
-- auditoria guarda a origem externa.

create or replace function public.acordo_avista_previa(
  p_pagamento_id uuid,
  p_titulo_ids uuid[] default null
)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to 'public'
as $previa$
with
-- A margem mora num lugar so: validacao, faixa mostrada na tela e detalhe.
regra as (
  select 1.15::numeric as margem_segura
),
pag as (
  select p.id, p.aluno_id, p.aluno_nome, p.matricula, p.numero_parcela_completo, p.titulo_numero,
         p.valor_pago, p.valor_honorario, p.data_pagamento, p.status_conciliacao,
         p.operador_email, p.operador_nome,
         coalesce(p.retroativo, false) as retroativo,
         coalesce(p.dados, '{}'::jsonb) ? 'estornado_em' as estornado,
         ltrim(coalesce(p.numero_parcela_completo, ''), '0') as boleto,
         public.vencimento_do_pagamento(p.dados) as vencimento,
         case when coalesce(p.dados->>'valor_original', '') ~ '^\d+(\.\d+)?$'
              then (p.dados->>'valor_original')::numeric end as valor_original
    from public.pagamentos p
   where p.id = p_pagamento_id
),
b as (
  select pag.*,
         pag.boleto ~ '^5\d{10}$' as boleto_no_padrao,
         case when pag.boleto ~ '^5\d{10}$' then substr(pag.boleto, 2, 6) end as acordo6,
         case when pag.boleto ~ '^5\d{10}$' then nullif(ltrim(substr(pag.boleto, 2, 6), '0'), '') end as numero_ulbra,
         case when pag.boleto ~ '^5\d{10}$' then substr(pag.boleto, 8, 4) end as parcela4,
         round(case when coalesce(pag.valor_original, 0) > 0 then pag.valor_original
                    else pag.valor_pago end, 2) as valor_parcela
    from pag
),
fila as (
  select count(*) filter (where f.decisao is not null) as decididas
    from b join public.fila_pagamento_sem_vinculo f on f.pagamento_id = b.id
),
-- IDENTIDADE POR DUAS VARIAVEIS INDEPENDENTES. A matricula do arquivo leva ao
-- CPF pelo cadastro da Prime; o nome do arquivo tem de ser unico na base. So ha
-- aluno quando as duas apontam para o MESMO -- e, se o pagamento ja tiver
-- aluno, para esse tambem.
mat as (
  select count(distinct lpad(regexp_replace(pc.cpf, '\D', '', 'g'), 11, '0')) as n_cpf,
         min(lpad(regexp_replace(pc.cpf, '\D', '', 'g'), 11, '0')) as cpf11
    from b join public.prime_contratos pc on pc.registration = b.matricula
   where regexp_replace(coalesce(pc.cpf, ''), '\D', '', 'g') <> ''
),
-- CADASTRO DUPLICADO MESCLADO NAO CONTA (18/09/2026). So sai da contagem a
-- ficha que a funcao oficial mesclar_aluno_duplicado marcou: status_jornada
-- CADASTRO_DUPLICADO E a observacao que ela grava. Duas fichas ativas com o
-- mesmo CPF ou nome continuam bloqueando.
cadastro_valido as (
  select a.* from public.alunos a
   where not (coalesce(a.status_jornada, '') = 'CADASTRO_DUPLICADO'
              and coalesce(a.observacao, '') like '%CADASTRO DUPLICADO mesclado em%')
),
aluno_mat as (
  select count(a.id) as n, min(a.id::text)::uuid as aluno_id
    from mat join cadastro_valido a
      on lpad(regexp_replace(coalesce(a.cpf, ''), '\D', '', 'g'), 11, '0') = mat.cpf11
   where mat.n_cpf = 1
),
aluno_nom as (
  select count(a.id) as n, min(a.id::text)::uuid as aluno_id
    from b join cadastro_valido a
      on translate(upper(regexp_replace(trim(both from a.nome), '\s+', ' ', 'g')),
                   'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'AAAAAEEEEIIIIOOOOOUUUUC')
       = translate(upper(regexp_replace(trim(both from b.aluno_nome), '\s+', ' ', 'g')),
                   'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'AAAAAEEEEIIIIOOOOOUUUUC')
   where coalesce(trim(b.aluno_nome), '') <> ''
),
ident as (
  select mat.n_cpf, am.n as n_matricula, an.n as n_nome,
         am.aluno_id as aluno_por_matricula, an.aluno_id as aluno_por_nome,
         (select b.aluno_id from b) as aluno_no_pagamento,
         case when am.n = 1 and an.n = 1 and am.aluno_id = an.aluno_id
                   and coalesce((select b.aluno_id from b) = am.aluno_id, true)
              then am.aluno_id end as aluno_id
    from mat, aluno_mat am, aluno_nom an
),
al as (
  select a.id, a.nome, a.cpf, a.cpf_mascarado, a.matricula, a.unidade, a.status_atual,
         a.responsavel_atual_email, a.responsavel_atual_nome, a.saldo_total
    from public.alunos a join ident on a.id = ident.aluno_id
),
op as (
  select count(u.id) as n, min(u.email) as email,
         min(coalesce(nullif(trim(u.nome_exibicao), ''), u.nome)) as nome,
         coalesce(bool_or(u.ativo and u.perfil = 'operador'), false) as operador_ativo
    from b join public.usuarios u on lower(u.email) = lower(b.operador_email)
),
-- O ACORDO TEM DE SER DE UM BOLETO SO. Outro pagamento, outra parcela ou outro
-- titulo com o prefixo 5+acordo significa parcelado -- fora deste registro.
mesmo as (
  select
    (select count(*) from public.pagamentos g
      where g.id <> b.id
        and ltrim(coalesce(g.numero_parcela_completo, ''), '0') like '5' || b.acordo6 || '%') as outros_pagamentos,
    (select count(*) from public.parcelas q
      where q.boleto like '5' || b.acordo6 || '%') as parcelas_do_acordo,
    (select count(*) from public.acordos_titulos t
      where coalesce(t.tipo_boleto, '') = 'Acordo'
        and ltrim(coalesce(t.documento, ''), '0') like '5' || b.acordo6 || '%') as titulos_do_acordo,
    (select count(*) from public.acordos a
      where ltrim(coalesce(a.numero_ulbra, ''), '0') = b.numero_ulbra) as acordos_com_numero,
    (select jsonb_build_object('numero_ulbra', x.numero_ulbra, 'importado_em', x.criado_em)
       from public.acordos x
      where x.criado_por_email = 'importacao@sistema'
        and (case when x.numero_ulbra ~ '^\d{1,9}$' then x.numero_ulbra::bigint end)
            > (case when b.numero_ulbra ~ '^\d{1,9}$' then b.numero_ulbra::bigint end)
        and (x.criado_em at time zone 'America/Sao_Paulo')::date < b.data_pagamento
      order by (case when x.numero_ulbra ~ '^\d{1,9}$' then x.numero_ulbra::bigint end), x.criado_em
      limit 1) as evidencia_existia_antes
    from b
   where b.acordo6 is not null
),
tit as (
  select t.id, t.aluno_id, t.documento, t.vencimento, t.tipo_boleto, t.situacao, t.status,
         t.acordo_id, t.origem_liquidacao,
         round(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0), 2) as valor,
         exists (select 1 from public.acordo_titulo_vinculo v
                   join public.acordos a on a.id = v.acordo_id
                  where v.titulo_id = t.id and coalesce(v.ativo, true)
                    and upper(coalesce(a.status, '')) not in ('CANCELADO', 'CANCELADA')) as vinculo_vivo,
         t.id = any(coalesce(p_titulo_ids, '{}'::uuid[])) as escolhido
    from public.acordos_titulos t
   where t.id = any(coalesce(p_titulo_ids, '{}'::uuid[]))
      or (t.aluno_id = (select aluno_id from ident)
          and upper(coalesce(t.situacao, '')) in ('ABERTO', 'NEGOCIADO')
          and coalesce(t.tipo_boleto, '') <> 'Acordo')
),
tit_av as (
  select tit.*,
         case
           when tit.aluno_id is distinct from (select aluno_id from ident) then 'TITULO_DE_OUTRO_ALUNO'
           when coalesce(tit.tipo_boleto, '') = 'Acordo' then 'TITULO_E_BOLETO_DE_ACORDO'
           when tit.acordo_id is not null or tit.vinculo_vivo then 'TITULO_LIGADO_A_OUTRO_ACORDO'
           when tit.origem_liquidacao is not null then 'TITULO_LIQUIDADO_NA_ORIGEM'
           when upper(coalesce(tit.situacao, '')) <> 'ABERTO'
                or lower(coalesce(tit.status, '')) <> 'em_aberto' then 'TITULO_NAO_ESTA_EM_ABERTO'
           when tit.valor <= 0 then 'TITULO_SEM_VALOR'
         end as impedimento
    from tit
),
-- Sem escolha da gestao, a SUGESTAO e toda mensalidade elegivel do aluno. A
-- sugestao nunca grava: confirmar exige a lista escolhida explicitamente.
sel as (
  select * from tit_av
   where case when p_titulo_ids is null then impedimento is null else escolhido end
),
faltando as (
  select count(*) as n
    from unnest(coalesce(p_titulo_ids, '{}'::uuid[])) x
   where not exists (select 1 from public.acordos_titulos t where t.id = x)
),
tot as (
  select count(*) as n, coalesce(sum(valor), 0) as soma,
         count(*) filter (where impedimento is not null) as n_impedidos
    from sel
),
dup as (
  select count(*) as n
    from b join public.acordos a
      on a.aluno_id = (select aluno_id from ident)
     and a.status = 'ATIVO'
     and coalesce(a.valor_total, 0) = b.valor_parcela
     and coalesce(a.qtd_parcelas, 0) = 1
),
-- Saldo pela mesma conta de `recalcular_situacao_aluno`: parcelas vivas de
-- acordo nao encerrado + mensalidades em aberto sem vinculo vivo.
saldo as (
  select round(
           coalesce((select sum(p.valor)
                       from public.parcelas p join public.acordos a on a.id = p.acordo_id
                      where a.aluno_id = ident.aluno_id
                        and upper(coalesce(a.status, '')) not in ('CANCELADO', 'CANCELADA', 'QUITADO')
                        and upper(coalesce(p.status, '')) not in ('PAGO', 'CANCELADA', 'CANCELADO', 'ESTORNADA', 'ESTORNADO')), 0)
         + coalesce((select sum(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0))
                       from public.acordos_titulos t
                      where t.aluno_id = ident.aluno_id
                        and upper(coalesce(t.situacao, '')) in ('ABERTO', 'NEGOCIADO')
                        and coalesce(lower(t.status), '') not in ('quitada')
                        and coalesce(t.tipo_boleto, '') <> 'Acordo'
                        and not exists (select 1 from public.acordo_titulo_vinculo v
                                          join public.acordos a on a.id = v.acordo_id
                                         where v.titulo_id = t.id and coalesce(v.ativo, true)
                                           and upper(coalesce(a.status, '')) not in ('CANCELADO', 'CANCELADA', 'QUITADO'))), 0)
         , 2) as antes,
         (select count(*) from public.solicitacoes_confirmacao_pagamento s
           where s.aluno_id = ident.aluno_id::text and s.status = 'AGUARDANDO_CONFIRMACAO') as confirmacoes_pendentes
    from ident
),
v as (
  select x.ordem, x.codigo, coalesce(x.ok, false) as ok, x.detalhe
    from (values
      (1, 'PAGAMENTO_EXISTE',
          (select count(*) = 1 from b),
          'pagamento ' || p_pagamento_id::text),
      (2, 'ESTADO_AGUARDANDO_ACORDO',
          (select b.status_conciliacao = 'AGUARDANDO_ACORDO' from b),
          'estado atual: ' || coalesce((select b.status_conciliacao from b), '(sem estado)')),
      (3, 'FILA_SEM_DECISAO',
          (select decididas = 0 from fila),
          'a linha da fila não pode ter decisão registrada'),
      (4, 'PAGAMENTO_NAO_ESTORNADO_NEM_RETROATIVO',
          (select not b.estornado and not b.retroativo from b),
          'pagamento estornado ou retroativo não registra acordo'),
      (5, 'BOLETO_NO_PADRAO',
          (select b.boleto_no_padrao from b),
          'boleto ' || coalesce((select b.numero_parcela_completo from b), '(sem)') || ' precisa ser 5 + acordo(6) + parcela(4)'),
      (6, 'BOLETO_PARCELA_0001',
          (select b.parcela4 = '0001' from b),
          'parcela do boleto: ' || coalesce((select b.parcela4 from b), '?')),
      (7, 'UNICO_BOLETO_DO_ACORDO',
          (select outros_pagamentos = 0 and parcelas_do_acordo = 0 and titulos_do_acordo = 0 from mesmo),
          'outros pagamentos do acordo: ' || coalesce((select outros_pagamentos::text from mesmo), '?')
          || ' · parcelas com o prefixo: ' || coalesce((select parcelas_do_acordo::text from mesmo), '?')
          || ' · títulos do acordo: ' || coalesce((select titulos_do_acordo::text from mesmo), '?')),
      (8, 'NUMERO_ULBRA_INEXISTENTE',
          (select acordos_com_numero = 0 from mesmo),
          'acordo ULBRA ' || coalesce((select b.numero_ulbra from b), '?')
          || ': ' || coalesce((select acordos_com_numero::text from mesmo), '?') || ' registro(s) no CRM'),
      (9, 'AUSENCIA_EXPLICADA',
          (select evidencia_existia_antes is null from mesmo),
          coalesce(
            (select 'o acordo ' || (evidencia_existia_antes->>'numero_ulbra')
                    || ', de número maior, já veio na importação de '
                    || to_char(((evidencia_existia_antes->>'importado_em')::timestamptz) at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI')
                    || ', antes do dia do pagamento: este acordo já existia e não apareceu no relatório'
                    || ' | fora do fluxo normal: exige tratamento operacional à parte'
               from mesmo where evidencia_existia_antes is not null),
            'nenhum acordo de número maior foi importado antes do dia do pagamento')),
      (10, 'MATRICULA_APONTA_UM_ALUNO',
          (select n_cpf = 1 and n_matricula = 1 from ident),
          'matrícula ' || coalesce((select b.matricula from b), '(sem)') || ': '
          || (select n_cpf::text from ident) || ' CPF(s) na Prime, '
          || (select n_matricula::text from ident) || ' aluno(s) com esse CPF'),
      (11, 'NOME_APONTA_UM_ALUNO',
          (select n_nome = 1 from ident),
          (select n_nome::text from ident) || ' aluno(s) com o nome do arquivo'),
      (12, 'MATRICULA_E_NOME_MESMO_ALUNO',
          (select aluno_id is not null from ident),
          'por matrícula: ' || coalesce((select aluno_por_matricula::text from ident), '-')
          || ' · por nome: ' || coalesce((select aluno_por_nome::text from ident), '-')
          || ' · no pagamento: ' || coalesce((select aluno_no_pagamento::text from ident), '-')),
      -- AGUARDANDO_BAIXA e o estado normal de quem pagou e espera confirmacao:
      -- e exatamente o aluno deste registro. Encerrado por alguem (quitado,
      -- baixa realizada, saldo zero confirmado) e caso fechado a mao -- abrir
      -- acordo nele e decisao que nao cabe aqui.
      (13, 'ALUNO_NAO_ENCERRADO',
          (select not (upper(coalesce(al.status_atual, '')) like 'QUIT%'
                       or upper(coalesce(al.status_atual, '')) in
                          ('BAIXA_REALIZADA', 'SALDO_ZERO_CONFIRMADO', 'SEM_SALDO_EM_ABERTO'))
             from al),
          'situação do aluno: ' || coalesce((select al.status_atual from al), '-')),
      (14, 'VENCIMENTO_NO_ARQUIVO',
          (select b.vencimento is not null from b),
          'vencimento: ' || coalesce((select to_char(b.vencimento, 'DD/MM/YYYY') from b), '(ausente)')),
      (15, 'VALOR_COMPATIVEL_COM_A_BAIXA',
          (select b.valor_pago > 0
                  and b.valor_pago >= b.valor_parcela - 0.05
                  and b.valor_pago <= b.valor_parcela * 1.15 from b),
          'valor pago ' || coalesce((select b.valor_pago::text from b), '?')
          || ' para parcela de ' || coalesce((select b.valor_parcela::text from b), '?')
          || ' (o motor aceita de -R$ 0,05 a +15%)'),
      (16, 'OPERADOR_CADASTRADO',
          (select n = 1 from op),
          'operador do pagamento: ' || coalesce((select b.operador_email from b), '(sem)')),
      (17, 'TITULOS_ESCOLHIDOS',
          (select n >= 1 from tot) and (select n = 0 from faltando),
          (select n::text from tot) || ' mensalidade(s) selecionada(s)'
          || case when (select n from faltando) > 0
                  then ' · ' || (select n::text from faltando) || ' id(s) inexistente(s)' else '' end),
      (18, 'TITULOS_ELEGIVEIS',
          (select n_impedidos = 0 from tot),
          coalesce((select string_agg(coalesce(documento, id::text) || ': ' || impedimento, ' · ')
                      from sel where impedimento is not null),
                   'todas em aberto, do mesmo aluno e sem vínculo com outro acordo')),
      (19, 'SOMA_ATE_O_VALOR_PAGO',
          (select tot.n >= 1 and tot.soma <= b.valor_pago + 0.005 from tot, b),
          'soma das mensalidades ' || (select tot.soma::text from tot)
          || ' · valor pago ' || coalesce((select b.valor_pago::text from b), '?')
          || case when (select tot.soma > b.valor_pago + 0.005 from tot, b)
                  then ' · a soma passa do valor pago: o acordo não quita mais do que entrou'
                  else '' end),
      (20, 'DIFERENCA_DENTRO_DA_MARGEM_SEGURA',
          (select tot.n >= 1 and b.valor_pago <= tot.soma * regra.margem_segura + 0.005 from tot, b, regra),
          coalesce(
            (select 'valor pago ' || b.valor_pago::text || ' = soma × '
                    || replace(round(b.valor_pago / tot.soma, 4)::text, '.', ',')
                    || case when b.valor_pago > tot.soma * regra.margem_segura + 0.005
                            then ' · a diferença excede a margem segura de '
                                 || round((regra.margem_segura - 1) * 100)::text || '% (limite: soma × '
                                 || replace(regra.margem_segura::text, '.', ',') || ')'
                            else ' · dentro da margem segura (limite: soma × '
                                 || replace(regra.margem_segura::text, '.', ',') || ')' end
               from tot, b, regra where tot.soma > 0),
            'sem mensalidade escolhida, não há como medir a diferença')),
      (21, 'SEM_ACORDO_ATIVO_IDENTICO',
          (select n = 0 from dup),
          'acordos ATIVOS do aluno com o mesmo valor e 1 parcela: ' || (select n::text from dup))
    ) as x(ordem, codigo, ok, detalhe)
)
select jsonb_build_object(
  'origem', 'RECUPERACAO_ACORDO_PAGO_SEM_IMPORTACAO',
  'aprovado', (select bool_and(ok) from v),
  'bloqueios', coalesce((select jsonb_agg(codigo order by ordem) from v where not ok), '[]'::jsonb),
  'validacoes', (select jsonb_agg(jsonb_build_object('codigo', codigo, 'ok', ok, 'detalhe', detalhe) order by ordem) from v),
  'pagamento', (select jsonb_build_object(
      'id', b.id, 'data_pagamento', b.data_pagamento, 'valor_pago', b.valor_pago,
      'valor_honorario', b.valor_honorario, 'valor_original', b.valor_original,
      'vencimento', b.vencimento, 'boleto', b.numero_parcela_completo, 'titulo_numero', b.titulo_numero,
      'matricula', b.matricula, 'nome_no_arquivo', b.aluno_nome,
      'operador_email', b.operador_email, 'operador_nome', b.operador_nome,
      'status_conciliacao', b.status_conciliacao) from b),
  'identificacao', (select jsonb_build_object(
      'cpfs_na_matricula', n_cpf, 'alunos_por_matricula', n_matricula, 'alunos_por_nome', n_nome,
      'aluno_por_matricula', aluno_por_matricula, 'aluno_por_nome', aluno_por_nome,
      'aluno_no_pagamento', aluno_no_pagamento, 'aluno_id', aluno_id) from ident),
  'aluno', (select jsonb_build_object(
      'id', al.id, 'nome', al.nome, 'cpf_mascarado', al.cpf_mascarado, 'matricula_crm', al.matricula,
      'status_atual', al.status_atual,
      -- `_reabrir_aluno_com_divida_nova` roda ao nascer a parcela em aberto, como
      -- na importacao de acordo: AGUARDANDO_BAIXA vira ACORDO_FECHADO ate a
      -- rotina existente encerrar o aluno de saldo zero.
      'status_logo_apos', case when upper(coalesce(al.status_atual, '')) = 'AGUARDANDO_BAIXA'
                               then 'ACORDO_FECHADO' else al.status_atual end,
      'responsavel_antes', al.responsavel_atual_email,
      'responsavel_depois', case when coalesce(trim(al.responsavel_atual_email), '') = '' and op.operador_ativo
                                 then op.email else al.responsavel_atual_email end) from al, op),
  'boleto', (select jsonb_build_object(
      'no_padrao', b.boleto_no_padrao, 'numero_ulbra', b.numero_ulbra, 'parcela', b.parcela4,
      'unico_do_acordo', coalesce((select outros_pagamentos = 0 and parcelas_do_acordo = 0 and titulos_do_acordo = 0 from mesmo), false),
      'acordo_ja_existe', coalesce((select acordos_com_numero > 0 from mesmo), false),
      'evidencia_existia_antes', (select evidencia_existia_antes from mesmo)) from b),
  'acordo_a_criar', (select jsonb_build_object(
      'numero_ulbra', b.numero_ulbra, 'tipo', 'ACORDO', 'forma_pagamento', 'PARCELADO',
      'qtd_parcelas', 1, 'valor_total', b.valor_parcela, 'status', 'ATIVO',
      'operador_responsavel_email', op.email, 'operador_responsavel_nome', op.nome) from b, op),
  'parcela_a_criar', (select jsonb_build_object(
      'numero', 1, 'boleto', b.boleto, 'valor', b.valor_parcela, 'vencimento', b.vencimento,
      'status', case when b.vencimento < current_date then 'VENCIDA' else 'A_VENCER' end,
      'boleto_confiavel', true) from b),
  'titulos', jsonb_build_object(
      'selecao', case when p_titulo_ids is null then 'SUGERIDA' else 'GESTAO' end,
      'quantidade', (select n from tot),
      'soma', (select soma from tot),
      'faixa_valor_pago', (select jsonb_build_object('soma_minima', round(b.valor_pago / regra.margem_segura, 2),
                                                     'soma_maxima', b.valor_pago,
                                                     'margem_segura', regra.margem_segura) from b, regra),
      'selecionados', coalesce((select jsonb_agg(jsonb_build_object(
            'id', id, 'documento', documento, 'vencimento', vencimento, 'valor', valor,
            'impedimento', impedimento) order by vencimento, documento) from sel), '[]'::jsonb),
      'candidatos', coalesce((select jsonb_agg(jsonb_build_object(
            'id', id, 'documento', documento, 'vencimento', vencimento, 'valor', valor,
            'tipo_boleto', tipo_boleto, 'situacao', situacao, 'impedimento', impedimento,
            'selecionado', case when p_titulo_ids is null then impedimento is null else escolhido end)
            order by vencimento, documento) from tit_av), '[]'::jsonb)),
  'credito', (select jsonb_build_object('operador_email', op.email, 'operador_nome', op.nome,
                                        'operador_ativo', op.operador_ativo) from op),
  'saldo', (select jsonb_build_object(
      'gravado', (select al.saldo_total from al),
      'antes', saldo.antes,
      'esperado_depois', round(greatest(saldo.antes - (select soma from tot), 0), 2),
      'confirmacoes_pendentes', saldo.confirmacoes_pendentes,
      'confirmacoes_fecham_sozinhas', saldo.confirmacoes_pendentes > 0
                                      and saldo.antes - (select soma from tot) <= 0.005) from saldo),
  -- O que acontece em cadeia, por codigo que ja existe. Dito antes de gravar.
  'efeitos', (select jsonb_agg(e order by o) from (
      select 1 as o, 'o motor atual baixa a parcela 1 pelo boleto e o acordo fecha como QUITADO' as e
      union all
      select 2, 'as mensalidades escolhidas ficam PAGO (quitada) junto com o acordo'
      union all
      select 3, 'o crédito da baixa e a responsabilidade do acordo ficam com '
                || coalesce((select op.email from op), '(operador não identificado)')
                || ', operador do pagamento; quem confirma na gestão fica só na auditoria'
      union all
      select 4, 'o operador recebe a notificação padrão de acordo novo sob sua responsabilidade'
      union all
      select 5, 'o aluno passa de AGUARDANDO_BAIXA para ACORDO_FECHADO ao nascer a parcela (gatilho de reabertura, o mesmo da importação de acordos) e a rotina existente o encerra quando o saldo zera'
       where (select upper(coalesce(al.status_atual, '')) from al) = 'AGUARDANDO_BAIXA'
      union all
      select 6, (select saldo.confirmacoes_pendentes::text from saldo)
                || ' confirmação(ões) pendente(s) do aluno fecham sozinhas como PAGAMENTO_CONFIRMADO, porque o saldo zera'
       where (select saldo.confirmacoes_pendentes > 0 and saldo.antes - (select soma from tot) <= 0.005 from saldo)
      union all
      select 7, 'o pagamento sai da fila de pagamentos a conciliar como resolvido automaticamente'
    ) ef)
);
$previa$;

create or replace function public.acordo_avista_registrar(
  p_pagamento_id uuid, p_titulo_ids uuid[] default null, p_confirmar boolean default false
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '60s'
as $fn$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_titulos uuid[];
  v_previa jsonb;
  v_aluno uuid;
  v_acordo_id uuid;
  v_parcela_id uuid;
  v_vinculo jsonb;
  v_pagamento jsonb;
  v_marca text;
  v_depois jsonb;
begin
  -- Portao interno. EXECUTE continua com authenticated: revogar derrubaria a
  -- tela para a propria gestao.
  -- A PORTA DA GESTAO CONTINUA A MESMA. A etapa automatica entra pela segunda
  -- condicao -- `acordo_avista_porta_interna()` --, que exige a chave
  -- transacional E a pilha de chamada da rotina: de fora nao ha como produzir
  -- as duas.
  if not coalesce(public.usuario_e_gestao(), false)
     and not public.acordo_avista_porta_interna() then
    raise exception 'Registrar acordo à vista é decisão da gestão financeira.' using errcode = '42501';
  end if;
  -- sem JWT (rodada horaria ou importacao) o registro assina como sistema
  if v_email = '' then v_email := 'conciliacao@sistema'; end if;

  select array_agg(distinct x) into v_titulos
    from unnest(p_titulo_ids) x where x is not null;
  -- Lista vazia e escolha ("nenhuma"), nao pedido de sugestao: so NULL sugere.
  if p_titulo_ids is not null and v_titulos is null then
    v_titulos := '{}'::uuid[];
  end if;

  if not coalesce(p_confirmar, false) then
    return public.acordo_avista_previa(p_pagamento_id, v_titulos)
           || jsonb_build_object('ok', true, 'modo', 'SIMULACAO', 'gravou', false);
  end if;

  -- Confirmar nunca usa a sugestao: a lista de mensalidades tem de vir escolhida.
  if v_titulos is null or cardinality(v_titulos) = 0 then
    return jsonb_build_object('ok', false, 'modo', 'RECUSADO', 'gravou', false,
                              'bloqueios', jsonb_build_array('TITULOS_ESCOLHIDOS'),
                              'motivo', 'confirmar exige as mensalidades escolhidas pela gestão');
  end if;

  -- Dois cliques simultaneos no mesmo pagamento: o segundo espera e, ao reler,
  -- encontra o acordo ja criado e e recusado pela previa.
  perform pg_advisory_xact_lock(hashtextextended('acordo_avista:' || p_pagamento_id::text, 0));

  v_previa := public.acordo_avista_previa(p_pagamento_id, v_titulos);

  if not coalesce((v_previa ->> 'aprovado')::boolean, false) then
    return v_previa || jsonb_build_object('ok', false, 'modo', 'RECUSADO', 'gravou', false);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('acordo_ulbra:' || (v_previa -> 'acordo_a_criar' ->> 'numero_ulbra'), 0));

  v_aluno := (v_previa -> 'aluno' ->> 'id')::uuid;
  v_marca := 'RECUPERACAO_ACORDO_PAGO_SEM_IMPORTACAO | pagamento ' || p_pagamento_id::text
          || ' | boleto ' || (v_previa -> 'parcela_a_criar' ->> 'boleto')
          || ' | confirmado por ' || v_email
          || ' em ' || to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI');

  -- O ACORDO. Responsavel = operador do pagamento, preenchido na insercao para
  -- que `_acordo_herda_responsavel_do_aluno` nao o troque pelo dono do aluno.
  insert into public.acordos
    (aluno_id, cpf, tipo, forma_pagamento, valor_total, qtd_parcelas, status, unidade, saldo,
     observacao, criado_por_email, criado_por_nome, numero_ulbra,
     operador_responsavel_email, operador_responsavel_nome, criado_em, atualizado_em)
  select a.id, a.cpf, 'ACORDO', 'PARCELADO',
         (v_previa -> 'acordo_a_criar' ->> 'valor_total')::numeric, 1, 'ATIVO', a.unidade,
         (v_previa -> 'acordo_a_criar' ->> 'valor_total')::numeric,
         v_marca, v_email, 'Recuperação de acordo pago sem importação',
         v_previa -> 'acordo_a_criar' ->> 'numero_ulbra',
         v_previa -> 'acordo_a_criar' ->> 'operador_responsavel_email',
         v_previa -> 'acordo_a_criar' ->> 'operador_responsavel_nome',
         now(), now()
    from public.alunos a
   where a.id = v_aluno
  returning id into v_acordo_id;

  if v_acordo_id is null then
    raise exception 'RECUPERACAO_ABORTADA: o aluno % sumiu entre a previa e a gravacao', v_aluno;
  end if;

  -- A PARCELA, com o boleto do proprio pagamento. `boleto_confiavel` e
  -- verdadeiro porque o numero nao foi inferido: veio impresso no boleto pago.
  insert into public.parcelas
    (acordo_id, numero, valor, vencimento, status, is_entrada, boleto, boleto_confiavel,
     observacao, criado_em, atualizado_em)
  values (v_acordo_id, 1,
          (v_previa -> 'parcela_a_criar' ->> 'valor')::numeric,
          (v_previa -> 'parcela_a_criar' ->> 'vencimento')::date,
          v_previa -> 'parcela_a_criar' ->> 'status',
          false,
          v_previa -> 'parcela_a_criar' ->> 'boleto',
          true, v_marca, now(), now())
  returning id into v_parcela_id;

  -- AS MENSALIDADES, pela funcao que ja existe (as quatro coisas do vinculo).
  v_vinculo := public.vincular_titulos_acordo(v_titulos, v_acordo_id);
  if not coalesce((v_vinculo ->> 'ok')::boolean, false)
     or coalesce((v_vinculo ->> 'vinculados')::int, -1) <> cardinality(v_titulos) then
    raise exception 'RECUPERACAO_ABORTADA: o vínculo das mensalidades não saiu como simulado (%)', v_vinculo::text;
  end if;

  -- A AMARRA, PROVADA (18/09/2026). `vinculados` conta mensalidades
  -- atualizadas, nao linhas de acordo_titulo_vinculo -- e ate hoje a linha do
  -- vinculo podia faltar sem ninguem perceber. Cada mensalidade escolhida tem de
  -- sair daqui com EXATAMENTE um vinculo ativo, e com este acordo. Faltou uma,
  -- nada fica gravado: nao existe acordo parcial.
  if exists (select 1 from unnest(v_titulos) x
              where (select count(*) from public.acordo_titulo_vinculo v
                      where v.titulo_id = x and v.acordo_id = v_acordo_id
                        and coalesce(v.ativo, true)) <> 1) then
    raise exception 'RECUPERACAO_ABORTADA: mensalidade sem vínculo ativo com o acordo criado (esperados %, com vínculo %)',
      cardinality(v_titulos),
      (select count(distinct v.titulo_id) from public.acordo_titulo_vinculo v
        where v.titulo_id = any(v_titulos) and v.acordo_id = v_acordo_id and coalesce(v.ativo, true));
  end if;

  -- O PAGAMENTO, pela funcao que ja existe: grava o aluno e chama o motor, que
  -- encontra a parcela pelo boleto e baixa.
  v_pagamento := public.pagamento_vincular_aluno(p_pagamento_id, v_aluno, v_marca);
  if coalesce(v_pagamento -> 'conciliacao' ->> 'status', '') <> 'BAIXADO' then
    raise exception 'RECUPERACAO_ABORTADA: o motor não baixou a parcela criada (%)', coalesce(v_pagamento::text, 'null');
  end if;

  -- O ESTADO FINAL TEM DE SER O SIMULADO. Qualquer desvio desfaz tudo.
  if not exists (select 1 from public.parcelas
                  where id = v_parcela_id and upper(coalesce(status, '')) = 'PAGO'
                    and origem_baixa_ref = p_pagamento_id::text)
     or not exists (select 1 from public.acordos
                     where id = v_acordo_id and upper(coalesce(status, '')) = 'QUITADO'
                       and lower(coalesce(operador_responsavel_email, ''))
                           = lower(coalesce(v_previa -> 'acordo_a_criar' ->> 'operador_responsavel_email', '')))
     or exists (select 1 from public.acordos_titulos
                 where id = any(v_titulos) and upper(coalesce(situacao, '')) <> 'PAGO')
     -- mensalidade PAGO sem a amarra com o acordo que a quitou nao e estado final
     or exists (select 1 from unnest(v_titulos) x
                 where (select count(*) from public.acordo_titulo_vinculo v
                         where v.titulo_id = x and v.acordo_id = v_acordo_id
                           and coalesce(v.ativo, true)) <> 1) then
    raise exception 'RECUPERACAO_ABORTADA: o estado final difere do simulado para o pagamento %', p_pagamento_id;
  end if;

  select jsonb_build_object(
    'pagamento', (select jsonb_build_object('status_conciliacao', p.status_conciliacao, 'aluno_id', p.aluno_id,
                                            'origem_vinculo', p.origem_vinculo)
                    from public.pagamentos p where p.id = p_pagamento_id),
    'fila', (select jsonb_build_object('decisao', f.decisao, 'decidido_por', f.decidido_por)
               from public.fila_pagamento_sem_vinculo f where f.pagamento_id = p_pagamento_id),
    'acordo', (select jsonb_build_object('id', a.id, 'numero_ulbra', a.numero_ulbra, 'status', a.status,
                                         'operador_responsavel_email', a.operador_responsavel_email)
                 from public.acordos a where a.id = v_acordo_id),
    'parcela', (select jsonb_build_object('id', q.id, 'status', q.status, 'boleto', q.boleto,
                                          'confirmado_por_email', q.confirmado_por_email, 'origem_baixa', q.origem_baixa)
                  from public.parcelas q where q.id = v_parcela_id),
    'titulos', (select jsonb_agg(jsonb_build_object('id', t.id, 'documento', t.documento,
                                                    'situacao', t.situacao, 'status', t.status))
                  from public.acordos_titulos t where t.id = any(v_titulos)),
    'aluno', (select jsonb_build_object('saldo_total', a.saldo_total, 'situacao_operacional', a.situacao_operacional,
                                        'status_atual', a.status_atual,
                                        'responsavel_atual_email', a.responsavel_atual_email)
                from public.alunos a where a.id = v_aluno),
    'confirmacoes_pendentes', (select count(*) from public.solicitacoes_confirmacao_pagamento s
                                where s.aluno_id = v_aluno::text and s.status = 'AGUARDANDO_CONFIRMACAO'))
  into v_depois;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'RECUPERACAO_ACORDO_PAGO_SEM_IMPORTACAO', 'acordos', v_acordo_id,
          jsonb_build_object(
            'origem', 'RECUPERACAO_ACORDO_PAGO_SEM_IMPORTACAO',
            'confirmado_por', v_email,
            'confirmado_em', now(),
            'pagamento_id', p_pagamento_id,
            'acordo_id', v_acordo_id,
            'numero_ulbra', v_previa -> 'acordo_a_criar' ->> 'numero_ulbra',
            'parcela_id', v_parcela_id,
            'titulo_ids', to_jsonb(v_titulos),
            'operador_original', v_previa -> 'credito',
            'estado_antes', v_previa,
            'estado_depois', v_depois));

  return v_previa || jsonb_build_object(
    'ok', true, 'modo', 'CONFIRMADO', 'gravou', true,
    'acordo_id', v_acordo_id, 'parcela_id', v_parcela_id,
    'estado_depois', v_depois);
end;
$fn$;

create or replace function public._acordo_herda_responsavel_do_aluno()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_email text; v_nome text;
begin
  if new.operador_responsavel_email is not null then return new; end if;
  select al.responsavel_atual_email, al.responsavel_atual_nome
    into v_email, v_nome
    from public.alunos al where al.id = new.aluno_id;
  if v_email is not null then
    new.operador_responsavel_email := v_email;
    new.operador_responsavel_nome  := coalesce(new.operador_responsavel_nome, v_nome);
  end if;
  return new;
end;
$$;

drop function if exists public.pagamento_autorizar_origem_externa(uuid, text);
drop table if exists public.pagamento_origem_externa_autorizada;
