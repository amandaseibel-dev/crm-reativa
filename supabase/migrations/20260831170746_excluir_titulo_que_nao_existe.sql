-- Excluir de verdade um titulo que nao existe -- nao marcar como duplicado.
--
-- Amanda, 31/08: "eu quero excluir nao marcar como duplicado, duplicado esta
-- errado" e "tira esse botao de duplicado". Ela tem razao no termo: DUPLICADO e
-- a mesma coisa lancada duas vezes. O boleto do acordo cancelado nao e isso --
-- ele simplesmente NAO EXISTE. O rotulo errado deixaria o registro mentindo
-- sobre a propria natureza.
--
-- POR QUE EXCLUIR E SEGURO, ao contrario do que eu argumentei antes:
-- `acordos_titulos` tem o gatilho `trg_audit`, que em DELETE grava a LINHA
-- INTEIRA em `audit_log.dados_antes`, com usuario e data. O rastro nao se perde
-- -- so sai da tabela viva. Eu recusei a exclusao sem ter verificado isso.
--
-- ONDE ISSO APARECE. A importacao de titulos traz, alem das mensalidades, o
-- boleto do PROPRIO acordo (tipo_boleto = 'Acordo'). Ao cancelar o acordo, esse
-- boleto voltava a contar junto com as mensalidades originais -- a mesma divida
-- duas vezes. Visto duas vezes na mesma tarde:
--
--   Viviane Onofre Oliveira  R$ 15.849,13 -> R$ 4.760,80  (boleto R$ 11.088,33)
--   Keli Heberle             R$  6.794,69 -> R$ 4.550,19  (dois, R$ 2.244,50)
--
-- GUARDAS. So gestao; motivo obrigatorio; titulo PAGO recusado (baixa errada se
-- resolve pelo Financeiro); titulo vinculado a acordo ATIVO recusado -- se ele
-- sustenta um acordo vigente, apagar quebraria o acordo. A movimentacao e
-- gravada ANTES do delete, com documento e valor, para a ficha do aluno contar a
-- historia mesmo depois de a linha sumir.
--
-- E O GATILHO PARA DE CRIAR O PROBLEMA. `titulos_por_status_acordo` devolvia
-- para ABERTO todos os titulos vinculados ao cancelar. Agora o boleto do proprio
-- acordo vai para CANCELADA -- que e o que ele e -- e SO quando ha mensalidade
-- voltando junto. A condicao importa: em 15 alunos com boleto de acordo aberto,
-- 9 NAO tem mensalidade nenhuma; neles o boleto e a UNICA representacao da
-- divida, e retira-lo apagaria R$ 22.478,74 sem nada no lugar.
--
-- Gatilho nao apaga linha sozinho. Excluir fica com a gestao, na ficha.
--
-- DESFAZER: supabase/rollbacks/20260831310000_excluir_titulo_que_nao_existe.rollback.sql

create or replace function public.titulo_excluir(
  p_titulo_id uuid,
  p_motivo    text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
  v_aluno uuid; v_sit text; v_valor numeric; v_doc text; v_tipo text;
begin
  if not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_motivo,''))) < 5 then
    raise exception 'Escreva o motivo -- por que este titulo nao existe.';
  end if;

  select t.aluno_id, upper(coalesce(t.situacao,'')), t.documento, t.tipo_boleto,
         coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)
    into v_aluno, v_sit, v_doc, v_tipo, v_valor
    from public.acordos_titulos t where t.id = p_titulo_id;

  if v_aluno is null then
    raise exception 'Titulo nao encontrado.';
  end if;
  if v_sit = 'PAGO' then
    raise exception 'Este titulo esta PAGO -- nao exclua. Se a baixa e que esta errada, desfaca pelo Financeiro.';
  end if;
  if exists (select 1 from public.acordo_titulo_vinculo v
              join public.acordos a on a.id = v.acordo_id
             where v.titulo_id = p_titulo_id and coalesce(v.ativo,true)
               and upper(coalesce(a.status,'')) = 'ATIVO') then
    raise exception 'Este titulo sustenta um acordo ATIVO. Desvincule antes de excluir.';
  end if;

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em, valor_movimentacao)
  values
    (v_aluno::text, 'TITULO_EXCLUIDO',
     'Titulo ' || coalesce(v_doc,'(sem documento)')
       || coalesce(' (' || v_tipo || ')','') || ' excluido: ' || btrim(p_motivo),
     v_email, v_email, now(), v_valor);

  delete from public.acordo_titulo_vinculo where titulo_id = p_titulo_id;
  delete from public.acordos_titulos where id = p_titulo_id;

  begin perform public.recalcular_situacao_aluno(v_aluno, 'titulo_excluido'); exception when others then null; end;

  return jsonb_build_object('ok', true, 'aluno_id', v_aluno,
                            'documento', v_doc, 'valor_retirado', v_valor);
end;
$function$;

revoke all on function public.titulo_excluir(uuid, text) from public, anon;
grant execute on function public.titulo_excluir(uuid, text) to authenticated, service_role;

create or replace function public.titulos_por_status_acordo()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_tem_mensalidade boolean;
begin
  if new.status = 'QUITADO' then
    update public.acordos_titulos t set situacao = 'PAGO', atualizado_em = now()
      from public.acordo_titulo_vinculo v
     where v.titulo_id = t.id and v.acordo_id = new.id and coalesce(v.ativo, true)
       and t.situacao in ('ABERTO','NEGOCIADO');

  elsif new.status = 'CANCELADO' then
    select exists (
      select 1 from public.acordos_titulos t
        join public.acordo_titulo_vinculo v on v.titulo_id = t.id
       where v.acordo_id = new.id and coalesce(v.ativo, true)
         and t.situacao = 'NEGOCIADO'
         and coalesce(t.tipo_boleto,'') <> 'Acordo'
    ) into v_tem_mensalidade;

    update public.acordos_titulos t set situacao = 'ABERTO', atualizado_em = now()
      from public.acordo_titulo_vinculo v
     where v.titulo_id = t.id and v.acordo_id = new.id and coalesce(v.ativo, true)
       and t.situacao = 'NEGOCIADO'
       and coalesce(t.tipo_boleto,'') <> 'Acordo';

    if v_tem_mensalidade then
      update public.acordos_titulos t
         set situacao = 'CANCELADA',
             motivo_ajuste = coalesce(t.motivo_ajuste,'')
                             || case when coalesce(t.motivo_ajuste,'') = '' then '' else ' | ' end
                             || 'boleto do proprio acordo, CANCELADO junto com o acordo em '
                             || to_char(now(),'DD/MM/YYYY')
                             || ' -- as mensalidades originais voltaram a contar.',
             atualizado_em = now()
        from public.acordo_titulo_vinculo v
       where v.titulo_id = t.id and v.acordo_id = new.id and coalesce(v.ativo, true)
         and t.situacao = 'NEGOCIADO'
         and coalesce(t.tipo_boleto,'') = 'Acordo';
    else
      update public.acordos_titulos t set situacao = 'ABERTO', atualizado_em = now()
        from public.acordo_titulo_vinculo v
       where v.titulo_id = t.id and v.acordo_id = new.id and coalesce(v.ativo, true)
         and t.situacao = 'NEGOCIADO'
         and coalesce(t.tipo_boleto,'') = 'Acordo';
    end if;
  end if;

  return new;
end;
$function$;
