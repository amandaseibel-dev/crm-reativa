-- Duas correções que nasceram do mesmo dia de operação (2026-08-25).
--
-- 1) TRAVA: mensalidade não pode voltar ao estado "vinculada sem vínculo".
--
--    Havia 519 títulos (123 alunos, R$ 587.613,87) com `status = 'vinculada'`
--    mas `situacao = 'ABERTO'`, `acordo_id` nulo e NENHUMA linha em
--    acordo_titulo_vinculo. Meio-vinculado. O efeito era perverso:
--      - a tela lê o STATUS -> mostra "Já negociada / vinculada" e marca como
--        INELEGÍVEL, então clicar em vincular não fazia nada;
--      - aluno_saldo_pendente_detalhe lê a SITUAÇÃO -> conta como aberto.
--    Ou seja: a mesma dívida somada duas vezes E o operador sem como consertar.
--
--    Já existe a trigger titulo_situacao_por_vinculo, que normaliza o título
--    quando o VÍNCULO muda. Faltava o espelho: normalizar quando o TÍTULO muda
--    (import, update direto, rotina). Esta trava fecha esse lado.
--
--    Ela é NARROW de propósito -- só age na combinação exatamente quebrada
--    (vinculada + ABERTO + sem acordo_id + sem vínculo). O caminho legítimo
--    (vincular_titulos_acordo) grava situacao='NEGOCIADO' e acordo_id, então
--    não é tocado. E normaliza em vez de dar erro: bloquear import por causa
--    disso pararia carga de dados por um problema que se conserta sozinho.
--
-- 2) HISTÓRICO: baixa conta como trabalho de quem deu a baixa.
--
--    Em 25/08 a Amanda deu 159 baixas (46 alunos) e o histórico creditava a ela
--    3 confirmações. Motivo: a baixa FECHA a solicitação, mas quem fecha é
--    rotina automática, que não assina -- dos 46 alunos, 35 viraram
--    ENCERRADO_VIA_ACORDO e 4 PAGAMENTO_CONFIRMADO, todos sem autor.
--    Em baixas_pagamento, porém, `baixado_por_email` ESTÁ correto. Então o
--    histórico passa a ler de lá também, como ação 'BAIXA'.
--
-- Rollback: supabase/rollbacks/20260825230000_trava_vinculada_sem_vinculo_e_baixa_no_historico.rollback.sql

------------------------------------------------------------------------------
-- 1) Trava
------------------------------------------------------------------------------
create or replace function public.tg_titulo_normaliza_vinculo_incoerente()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'public'
as $function$
begin
  if lower(coalesce(NEW.status, '')) = 'vinculada'
     and upper(coalesce(NEW.situacao, '')) = 'ABERTO'
     and NEW.acordo_id is null
     and not exists (
       select 1 from public.acordo_titulo_vinculo v
        where v.titulo_id = NEW.id and coalesce(v.ativo, true)
     )
  then
    -- Sem vínculo nenhum, o título é o que sempre foi: uma mensalidade aberta.
    NEW.status := 'em_aberto';
  end if;
  return NEW;
end;
$function$;

revoke all on function public.tg_titulo_normaliza_vinculo_incoerente() from public, anon, authenticated;

drop trigger if exists trg_titulo_normaliza_vinculo_incoerente on public.acordos_titulos;
create trigger trg_titulo_normaliza_vinculo_incoerente
  before insert or update on public.acordos_titulos
  for each row
  execute function public.tg_titulo_normaliza_vinculo_incoerente();

------------------------------------------------------------------------------
-- 1b) A ORIGEM do estado quebrado: desvincular_titulos_acordo
--
--     A função dizia, no próprio comentário, "Volta a mensalidade para ABERTO"
--     -- e gravava `situacao = 'ABERTO'` junto com `status = 'vinculada'`.
--     Ou seja, produzia exatamente a combinação incoerente, e só não quebrava
--     sempre porque o DELETE do vínculo, logo depois, dispara
--     titulo_situacao_por_vinculo, que normaliza. Título desvinculado por um
--     caminho que não passasse por esse DELETE ficava preso.
--
--     Aqui o status passa a ser 'em_aberto', que é o que a função sempre quis
--     dizer. Nada mais muda: mesma assinatura, mesmo retorno, mesma auditoria.
create or replace function public.desvincular_titulos_acordo(p_titulo_ids uuid[])
  returns jsonb
  language plpgsql
  security definer
  set search_path to 'public'
as $function$
declare
  v_email text := lower(coalesce(auth.email(),''));
  v_n int;
begin
  if v_email = '' then return jsonb_build_object('ok',false,'erro','NAO_AUTENTICADO'); end if;

  -- Volta a mensalidade para ABERTO (conta de novo no total do aluno).
  update public.acordos_titulos
     set acordo_id = null, situacao = 'ABERTO', status = 'em_aberto',
         vinculado_em = null, vinculado_por = null, atualizado_em = now()
   where id = any(p_titulo_ids);
  get diagnostics v_n = row_count;

  delete from public.acordo_titulo_vinculo where titulo_id = any(p_titulo_ids);

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'DESVINCULOU_TITULOS_ACORDO', 'acordos_titulos', null,
          jsonb_build_object('qtd', v_n, 'titulo_ids', p_titulo_ids));

  return jsonb_build_object('ok', true, 'desvinculados', v_n);
end;
$function$;

------------------------------------------------------------------------------
-- 2) Histórico com a baixa
------------------------------------------------------------------------------
create or replace function public.historico_confirmacoes_por_dia()
  returns table(dia date, usuario text, email text, acao text, automatico boolean, qtd bigint)
  language sql
  stable
  security definer
  set search_path to 'public'
as $function$
  with base as (
    select
      (s.confirmado_em at time zone 'America/Sao_Paulo')::date as dia,
      case when lower(btrim(coalesce(s.confirmado_por, ''))) like '%@%'
           then lower(btrim(s.confirmado_por)) end as email_autor,
      case
        when s.status = 'PAGAMENTO_CONFIRMADO'                           then 'CONFIRMADO'
        when s.status in ('CONCLUIDA_SALDO_ZERO','ENCERRADO_SALDO_ZERO')  then 'SALDO_ZERO'
        when s.status = 'PAGAMENTO_REJEITADO'                             then 'REJEITADO'
      end as acao
    from public.solicitacoes_confirmacao_pagamento s
    where s.confirmado_em is not null
      and s.status in ('PAGAMENTO_CONFIRMADO','CONCLUIDA_SALDO_ZERO',
                       'ENCERRADO_SALDO_ZERO','PAGAMENTO_REJEITADO')
      and (s.confirmado_em at time zone 'America/Sao_Paulo')::date
          >= (now() at time zone 'America/Sao_Paulo')::date - 30

    union all

    -- Baixa dada na Fila de Baixas. Aqui o autor é confiável.
    select
      (b.baixado_em at time zone 'America/Sao_Paulo')::date,
      case when lower(btrim(coalesce(b.baixado_por_email, ''))) like '%@%'
           then lower(btrim(b.baixado_por_email)) end,
      'BAIXA'
    from public.baixas_pagamento b
    where b.baixado_em is not null
      and (b.baixado_em at time zone 'America/Sao_Paulo')::date
          >= (now() at time zone 'America/Sao_Paulo')::date - 30
  )
  select
    b.dia,
    case when b.email_autor is null then 'Automático (sistema)'
         else coalesce(nullif(u.nome_exibicao,''), nullif(u.nome,''),
                       nullif(u.apelido,''), b.email_autor)
    end as usuario,
    coalesce(b.email_autor, '-') as email,
    b.acao,
    (b.email_autor is null) as automatico,
    count(*) as qtd
  from base b
  left join public.usuarios u on lower(u.email) = b.email_autor
  where b.acao is not null
  group by 1, 2, 3, 4, 5
  order by 1 desc, 6 desc;
$function$;

revoke all on function public.historico_confirmacoes_por_dia() from public, anon;
grant execute on function public.historico_confirmacoes_por_dia() to authenticated, service_role;
