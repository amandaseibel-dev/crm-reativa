-- Confirmacao de Pagamento passa a mostrar (e resolver) o titulo EM_CONFIRMACAO.
--
-- O FURO, MEDIDO EM 23/09/2026. Quando a mensalidade vira EM_CONFIRMACAO ela
-- sai da cobranca e o saldo do aluno zera. A fila do extrato so aceita aluno
-- com `saldo_total > 0.005`, entao o caso some exatamente de onde a gestao
-- trabalha: 516 titulos / 307 alunos / R$ 1.315.328,05 invisiveis, contra 152
-- titulos / 81 alunos que sobravam so por terem outra divida. A Conferencia
-- Prime ficou parada desde 19/09 (0 decisoes em 24h com 668 pendentes) porque a
-- fila dela nasce do TITULO, e o trabalho real nasce do DINHEIRO -- o extrato.
--
-- Amanda, 23/09/2026: "precisa ser facil fazer as coisas, em um lugar so [...]
-- eu estou fazendo pelo extrato do santander, tem muita coisa errada".
--
-- O QUE MUDA AQUI, e so isso:
--   1. aluno com titulo EM_CONFIRMACAO pendente entra na fila mesmo com o saldo
--      zerado -- antes o `where saldo_total > 0.005` o excluia;
--   2. duas colunas novas dizem quanto e quantos titulos esperam decisao;
--   3. o tipo de divida ganha 'EM_CONFIRMACAO', que traz o acumulado inteiro
--      sem o corte de periodo -- pendencia represada nao e fluxo do mes.
--
-- O QUE NAO MUDA: nenhuma regra financeira. A decisao continua nas RPCs da
-- Conferencia Prime (prime_conferencia_vincular / _seguir_pagamento /
-- _rejeitar), com as mesmas travas e o mesmo motivo obrigatorio. Esta migration
-- so faz o caso APARECER onde a decisao ja e tomada.
--
-- POR QUE DUAS PORTAS DE ENTRADA. A fila nasce do pagamento nao conferido no
-- periodo e continua assim: o aluno com titulo em confirmacao entra no fluxo
-- normal quando tem pagamento no periodo -- 72 alunos hoje, o caso "o dinheiro
-- entrou e o titulo ficou preso" (o do Gabriel Malaman). O acumulado (388
-- alunos, dos quais 316 sem pagamento recente) so aparece no tipo
-- 'EM_CONFIRMACAO': encher a fila diaria com 388 linhas seria trocar um
-- problema por outro.
--
-- DROP + CREATE porque o RETURNS TABLE ganhou colunas; `create or replace` nao
-- aceita mudanca de tipo de retorno. Os GRANTs sao refeitos logo abaixo --
-- authenticated continua com EXECUTE (o portao e interno, `usuario_e_gestao`),
-- nunca revoke.

drop function if exists public.conferencia_pagamentos(date, numeric, integer, date, text);

create or replace function public.conferencia_pagamentos(
  p_desde date default '2026-06-01'::date,
  p_valor_min numeric default 0,
  p_limite integer default 300,
  p_ate date default null::date,
  p_tipo_divida text default null::text
)
returns table(
  tipo text, aluno_id uuid, nome text, cpf text, responsavel text,
  entrou numeric, qtd_pagamentos integer, primeiro_pagamento date, ultimo_pagamento date,
  baixado numeric, qtd_baixas integer, baixado_por text, ultima_baixa date,
  saldo_aberto numeric, saldo_em_acordo numeric, saldo_em_mensalidade numeric,
  saldo_vencido numeric, tem_acordo boolean, quitado_em date, pagamento_ids uuid[],
  em_confirmacao numeric, qtd_em_confirmacao integer,
  total_linhas integer, total_pagamentos integer, total_entrou numeric,
  total_baixado numeric, total_saldo numeric
)
language plpgsql
stable security definer
set search_path to 'public'
set statement_timeout to '120s'
as $function$
declare
  v_ate date := coalesce(p_ate + 1, date '2999-12-31');
  v_so_confirmacao boolean := upper(coalesce(p_tipo_divida,'')) = 'EM_CONFIRMACAO';
begin
  if not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode = '42501';
  end if;

  return query
  with nao_conferido as (
    select p.id, p.aluno_id, p.aluno_nome, p.valor_pago, p.data_pagamento
      from public.pagamentos p
     where p.data_pagamento >= p_desde and p.data_pagamento < v_ate
       and not exists (select 1 from public.conciliacao_pagamento_conferido c
                        where c.pagamento_id = p.id)
  ),
  -- Titulos que a Conferencia Prime tirou da cobranca e ainda esperam decisao.
  -- `materialized` de proposito: sao ~668 linhas lidas UMA vez. Como lateral
  -- por aluno isto viraria uma volta por linha do universo -- foi assim que a
  -- lateral antiga da Projecao passou de 39 para 810 voltas e deu timeout.
  emconf as materialized (
    select t.aluno_id aid,
           round(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)), 2) valor,
           count(*)::int qtd
      from public.acordos_titulos t
      join public.prime_conferencia_decisao d
        on d.titulo_id = t.id and d.decisao = 'PENDENTE'
     where upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO'
       and t.aluno_id is not null
     group by t.aluno_id
  ),
  pg as (
    select n.aluno_id aid, sum(n.valor_pago) entrou, count(*)::int qtd,
           min(n.data_pagamento) prim, max(n.data_pagamento) ult, array_agg(n.id) pags
      from nao_conferido n where n.aluno_id is not null group by n.aluno_id
  ),
  bx as (
    select b.aluno_id::uuid aid, sum(b.valor_pago) baixado, count(*)::int qtd,
           max(b.baixado_em)::date ult_baixa,
           array_agg(distinct lower(coalesce(nullif(btrim(b.baixado_por_email),''), '?'))) emails
      from public.baixas_pagamento b
     where upper(coalesce(b.status_baixa,'')) = 'REALIZADA'
       and b.data_pagamento >= p_desde and b.data_pagamento < v_ate
       and b.aluno_id ~ '^[0-9a-f-]{36}$'
     group by 1
  ),
  universo as (
    select coalesce(pg.aid, bx.aid) aid,
           coalesce(pg.entrou,0) entrou, coalesce(pg.qtd,0) qtd_pg,
           pg.prim, pg.ult, coalesce(pg.pags, '{}'::uuid[]) pags,
           coalesce(bx.baixado,0) baixado, coalesce(bx.qtd,0) qtd_bx,
           bx.ult_baixa, bx.emails
      from pg left join bx on bx.aid = pg.aid
     union all
    -- Segunda porta, SO no tipo 'EM_CONFIRMACAO': a pendencia represada nao tem
    -- pagamento no periodo, logo nunca entraria pela porta do extrato.
    select e.aid, 0::numeric, 0, null::date, null::date, '{}'::uuid[],
           0::numeric, 0, null::date, null::text[]
      from emconf e
     where v_so_confirmacao
       and not exists (select 1 from pg where pg.aid = e.aid)
  ),
  com_aluno as (
    select 'ALUNO'::text x_tipo, u.aid x_id, al.nome x_nome, al.cpf x_cpf,
           coalesce(al.responsavel_atual_nome,'(sem dono)') x_resp,
           round(u.entrou,2) x_entrou, u.qtd_pg, u.prim, u.ult,
           round(u.baixado,2) x_baixado, u.qtd_bx,
           (select string_agg(distinct coalesce(
                     us.nome,
                     case when e = 'rotina@sistema' then 'automático' end,
                     e), ', ')
              from unnest(u.emails) e
              left join public.usuarios us on lower(us.email) = e) x_quem,
           u.ult_baixa x_ult_baixa,
           round(coalesce(al.saldo_total,0),2) x_saldo,
           round(coalesce(pc.parcelas,0),2) x_acordo,
           round(coalesce(tt.titulos,0),2) x_mens,
           round(coalesce(al.saldo_vencido,0),2) x_venc,
           exists (select 1 from public.acordos a
                    where a.aluno_id = u.aid and upper(coalesce(a.status,''))='ATIVO') x_tem_ac,
           qz.quitado_em x_quit, u.pags x_pags,
           coalesce(ec.valor,0) x_emconf, coalesce(ec.qtd,0) x_qtd_emconf
      from universo u
      join public.alunos al on al.id = u.aid
      left join emconf ec on ec.aid = u.aid
      left join lateral (
        select coalesce(sum(pa.valor),0) parcelas
          from public.acordos ac join public.parcelas pa on pa.acordo_id = ac.id
         where ac.aluno_id = u.aid and upper(coalesce(ac.status,''))='ATIVO' and pa.status <> 'PAGO'
      ) pc on true
      left join lateral (
        select coalesce(sum(coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)),0) titulos
          from public.acordos_titulos t
         where t.aluno_id = u.aid and upper(coalesce(t.situacao,''))='ABERTO'
      ) tt on true
      left join lateral (
        select c.quitado_em::date quitado_em from public.casos c
         where c.aluno_id = u.aid and c.quitado_em is not null
         order by c.quitado_em desc limit 1
      ) qz on true
     -- Saldo zerado deixa de excluir quando ha titulo esperando decisao: era
     -- exatamente isso que escondia 516 titulos.
     where (coalesce(al.saldo_total,0) > 0.005 or coalesce(ec.valor,0) > 0.005)
       and (coalesce(u.entrou,0) >= coalesce(p_valor_min,0)
            or (v_so_confirmacao and coalesce(ec.valor,0) >= coalesce(p_valor_min,0)))
       and (upper(coalesce(p_tipo_divida,'')) = 'TUDO'
            or coalesce(tt.titulos,0) > 0.005
            or coalesce(al.saldo_vencido,0) > 0.005
            or coalesce(al.responsavel_atual_nome,'') = ''
            or coalesce(ec.valor,0) > 0.005)
       and (p_tipo_divida is null
            or upper(p_tipo_divida) = 'TUDO'
            or (upper(p_tipo_divida) = 'MENSALIDADE' and coalesce(tt.titulos,0) > 0.005)
            or (upper(p_tipo_divida) = 'ACORDO'      and coalesce(tt.titulos,0) <= 0.005)
            or (v_so_confirmacao and coalesce(ec.valor,0) > 0.005))
  ),
  sem_vinculo as (
    select 'SEM_VINCULO'::text, null::uuid, max(n.aluno_nome), null::text, '(sem dono)'::text,
           round(sum(n.valor_pago),2), count(*)::int,
           min(n.data_pagamento), max(n.data_pagamento),
           0::numeric, 0, null::text, null::date,
           0::numeric, 0::numeric, 0::numeric, 0::numeric,
           false, null::date, array_agg(n.id),
           0::numeric, 0
      from nao_conferido n
     where n.aluno_id is null and coalesce(btrim(n.aluno_nome),'') <> ''
     group by upper(btrim(n.aluno_nome))
    having sum(n.valor_pago) >= coalesce(p_valor_min,0) and p_tipo_divida is null
  ),
  tudo as (select * from com_aluno union all select * from sem_vinculo),
  resumo as (
    select count(*)::int t_l, coalesce(sum(t.qtd_pg),0)::int t_p,
           coalesce(sum(t.x_entrou),0) t_e, coalesce(sum(t.x_baixado),0) t_b,
           coalesce(sum(t.x_saldo),0) t_s
      from tudo t
  )
  select t.x_tipo, t.x_id, t.x_nome, t.x_cpf, t.x_resp,
         t.x_entrou, t.qtd_pg, t.prim, t.ult, t.x_baixado, t.qtd_bx,
         t.x_quem, t.x_ult_baixa,
         t.x_saldo, t.x_acordo, t.x_mens, t.x_venc, t.x_tem_ac, t.x_quit, t.x_pags,
         t.x_emconf, t.x_qtd_emconf,
         r.t_l, r.t_p, round(r.t_e,2), round(r.t_b,2), round(r.t_s,2)
    from tudo t cross join resumo r
   -- Quem tem titulo esperando decisao sobe: e o trabalho que estava invisivel.
   order by (t.x_quit is not null and t.ult is not null and t.ult > t.x_quit) desc,
            (coalesce(t.x_emconf,0) > 0.005) desc,
            (coalesce(t.x_mens,0) > 0.005) desc,
            t.x_mens desc, t.x_entrou desc, t.x_saldo desc, t.x_nome
   limit greatest(coalesce(p_limite,300),1);
end;
$function$;

grant execute on function public.conferencia_pagamentos(date, numeric, integer, date, text)
  to authenticated, service_role;


-- O detalhe do caso, para a linha da fila abrir sem trocar de tela.
--
-- POR QUE O "EFEITO" VEM DO BANCO, e nao de um texto na tela: quem decide o
-- que o clique faz sao `vincular_titulos_acordo` (acordo quitado com todas as
-- parcelas pagas deixa a mensalidade PAGO/quitada; acordo ativo deixa
-- NEGOCIADO/vinculada) e a trava de `prime_conferencia_vincular`
-- (ACORDO_QUITADO_SEM_PAGAMENTO_REAL). Repetir essa regra em JavaScript seria
-- uma quinta copia da mesma verdade -- aqui ela e lida das mesmas funcoes que
-- vao executar, entao a tela nao pode prometer o que o backend recusa.
--
-- Medido em 23/09/2026 sobre os 138 pendentes com acordo candidato:
--   72 VIRA_PAGO, 65 VIRA_NEGOCIADO, 1 ACORDO_SEM_DINHEIRO_REAL.

create or replace function public.conferencia_em_confirmacao_do_aluno(p_aluno_id uuid)
returns table(
  titulo_id uuid, documento text, vencimento date, valor numeric,
  subgrupo text, motivo_entrada text, prioridade text, dias_pendente integer,
  acordo_id uuid, acordo_numero text, acordo_status text,
  efeito text, efeito_texto text,
  pagamento_id uuid, pagamento_data date, pagamento_valor numeric, pagamento_status text,
  pode_seguir_pagamento boolean, exige_motivo boolean, revisao_obrigatoria boolean
)
language plpgsql
stable security definer
set search_path to 'public'
set statement_timeout to '30s'
as $function$
begin
  if not (public.crm_usuario_pode_quitar_baixar() or coalesce(public.usuario_e_gestao(), false)) then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode = '42501';
  end if;
  if p_aluno_id is null then return; end if;

  return query
  with base as (
    select d.titulo_id, t.documento, t.vencimento,
           round(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0), 2) as valor,
           d.subgrupo, d.motivo_entrada, d.revisao_obrigatoria,
           d.triagem->>'prioridade' as prioridade,
           greatest(0, (current_date - d.detectado_em::date))::int as dias_pendente,
           -- o acordo da deteccao, ou o candidato que a evidencia registrou
           coalesce(d.acordo_id, (d.evidencia->'acordo_candidato'->>'acordo_id')::uuid) as acordo_id,
           nullif(d.evidencia->>'pagamento_candidato_id','')::uuid as pagamento_id,
           d.evidencia->>'pagamento_candidato_status' as pagamento_status,
           (d.evidencia->'pagamentos_proximos'->0->>'data')::date as pagamento_data,
           (d.evidencia->'pagamentos_proximos'->0->>'valor')::numeric as pagamento_valor
      from public.prime_conferencia_decisao d
      join public.acordos_titulos t on t.id = d.titulo_id
     where d.aluno_id = p_aluno_id
       and d.decisao = 'PENDENTE'
       and upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO'
  ),
  comer as (
    select b.*, upper(coalesce(a.status,'')) as acordo_status,
           coalesce(a.numero_acordo::text,'') as acordo_numero,
           case
             when b.acordo_id is null then false
             when upper(coalesce(a.status,'')) <> 'QUITADO' then false
             else coalesce(
               (public.prime_liquidacao_acordo_pago_de_verdade(b.acordo_id)->>'suficiente')::boolean,
               false)
           end as dinheiro_cobre
      from base b
      left join public.acordos a on a.id = b.acordo_id and a.aluno_id = p_aluno_id
  )
  select c.titulo_id, c.documento, c.vencimento, c.valor,
         c.subgrupo, c.motivo_entrada, c.prioridade, c.dias_pendente,
         c.acordo_id, nullif(c.acordo_numero,''), nullif(c.acordo_status,''),
         case
           when c.acordo_id is null or c.acordo_status = '' then 'SEM_ACORDO_SUGERIDO'
           when c.acordo_status in ('CANCELADO','CANCELADA')  then 'ACORDO_CANCELADO'
           when c.acordo_status = 'QUITADO' and c.dinheiro_cobre then 'VIRA_PAGO'
           when c.acordo_status = 'QUITADO'                   then 'ACORDO_SEM_DINHEIRO_REAL'
           when c.acordo_status = 'ATIVO'                     then 'VIRA_NEGOCIADO'
           else 'ACORDO_NAO_ELEGIVEL'
         end,
         case
           when c.acordo_id is null or c.acordo_status = '' then
             'Sem acordo sugerido: decida pela ficha ou mantenha em confirmação'
           when c.acordo_status in ('CANCELADO','CANCELADA') then
             'O acordo sugerido está cancelado — o vínculo é recusado'
           when c.acordo_status = 'QUITADO' and c.dinheiro_cobre then
             'Vincular deixa a mensalidade PAGA: o acordo ' || c.acordo_numero
               || ' está quitado e os pagamentos baixados cobrem o total'
           when c.acordo_status = 'QUITADO' then
             'O acordo ' || c.acordo_numero || ' está quitado mas os pagamentos baixados '
               || 'não cobrem o total — a trava recusa e o título fica em confirmação'
           when c.acordo_status = 'ATIVO' then
             'Vincular deixa a mensalidade NEGOCIADA: a dívida passa a viver nas parcelas do acordo '
               || c.acordo_numero
           else 'Acordo em estado que não recebe vínculo'
         end,
         c.pagamento_id, c.pagamento_data, c.pagamento_valor, c.pagamento_status,
         -- "Seguir pagamento" so vale para dinheiro que AINDA nao foi baixado:
         -- prime_conferencia_seguir_pagamento recusa BAIXADO com
         -- PAGAMENTO_JA_CONCLUIDO e manda vincular ao acordo dele.
         (c.pagamento_id is not null
          and coalesce(c.pagamento_status,'') not in ('BAIXADO','TITULO_ORIGINAL_LIQUIDADO')),
         (coalesce(c.subgrupo,'') not in ('A2_COBRE','B_ACORDO_COMPROVADO','A_PAGAMENTO_COMPROVADO')
          or c.revisao_obrigatoria),
         c.revisao_obrigatoria
    from comer c
   order by c.valor desc, c.documento;
end;
$function$;

grant execute on function public.conferencia_em_confirmacao_do_aluno(uuid)
  to authenticated, service_role;
