-- PARCELA DE ACORDO VISÍVEL PARA O DONO DO CASO -- M2 da regra permanente.
--
-- Regra permanente de distribuicao, artigo 4: "o responsavel operacional
-- acompanha mensalidade E parcela de acordo; parcela a vencer e vencida precisa
-- estar visivel ao responsavel pelo caso; a transferencia do caso NAO altera
-- autoria, honorario nem titularidade financeira".
--
-- O DEFEITO, MEDIDO EM 20/10/2026
--
-- As duas filas de parcela da tela do operador filtram pelo dono do ACORDO,
-- nao pelo dono do CASO:
--   * `parcelas_vencendo_2_dias` compara com `acordos.operador_responsavel_email`;
--   * `acordo_alertas_do_operador` compara com
--     `acordo_alertas_parcela.responsavel_email`, que o gerador preenche com o
--     mesmo dono do acordo.
-- Preservando a titularidade financeira -- como manda o artigo 4 e como a gestao
-- decidiu em 20/10 -- o responsavel operacional simplesmente NAO VE a parcela.
-- Medido: em 3.077 parcelas vivas o dono do caso e diferente do dono do acordo.
--
-- E as VENCIDAS nao estao em fila nenhuma: `parcelas_vencendo_2_dias` cobre
-- exatamente D-2 (30 parcelas hoje) e a tabela de alertas tem 23 nao resolvidos,
-- TODOS a vencer e ZERO vencidos.
--
-- O QUE MUDA, E POR QUE ASSIM
--
-- 1) As duas funcoes passam a enderecar pelo dono do CASO. E so o `where` de
--    leitura: `acordos.operador_responsavel_email` continua intocado, e com ele
--    honorario, autoria e credito. A tabela `acordo_alertas_parcela` tambem nao
--    e reescrita -- `responsavel_email` segue guardando quem fechou, como
--    registro.
--
-- 2) `parcelas_vencendo_2_dias` MANTEM a janela de D-2 exato. Isso e deliberado:
--    a tela usa esse resultado so para marcar o selo de "boleto vencendo"
--    (`alunosComBoletoVencendo`, PainelCarteira.jsx). Medido: abrir a janela para
--    as vencidas levaria o selo de 30 para 1.911 alunos -- a carteira inteira
--    acenderia e o selo perderia o sentido. Selo e selo; lista e lista.
--
-- 3) As VENCIDAS entram na LISTA, que e `acordo_alertas_do_operador`, com janela
--    de 30 dias. A assinatura ja suporta: `dias_restantes` fica negativo. Medido
--    por faixa, parcelas vivas de acordo nao cancelado:
--      a vencer (qualquer prazo) 3.383 | vencida ate 7d 221 | 8 a 30d 801
--      31 a 90d 1.331 | +90d 3.080
--    Ate 30 dias sao 1.022 parcelas, cerca de 120 por operador -- lista de
--    trabalho. Os +90 dias (3.080) nao sao acompanhamento de D-2: sao cobranca,
--    e o aluno ja esta na carteira do operador.
--
-- 4) Os bloqueios do artigo 6 passam a valer nas duas, o que hoje NAO acontece:
--    `nao_acionar` e `caso_encerrado_operacional` (que cobre suspensao de
--    cobranca, juridico e cancelamento). Medido: barra 8 parcelas por
--    `nao_acionar` e 5 por encerrado/suspenso/juridico.
--
-- 5) Sem duplicidade (artigo 4): as duas pernas da uniao sao disjuntas por data
--    -- o alerta cobre `vencimento >= current_date`, a perna nova cobre
--    `vencimento < current_date`. A mesma parcela nao pode sair nas duas.
--
-- O QUE NAO MUDA
--
--  * Nenhuma escrita. As tres funcoes sao `language sql` de leitura; nao ha
--    insert, update, delete nem chamada de rotina que escreva.
--  * Nenhum valor de parcela, pagamento, acordo ou titulo.
--  * `acordos.operador_responsavel_email` e
--    `acordo_alertas_parcela.responsavel_email`: nao sao escritos.
--  * `data_ultimo_acionamento`, `data_retorno`, agenda e historico.
--  * A assinatura das duas funcoes (mesmas colunas, mesmos tipos), para a tela
--    nao precisar mudar -- e por isso nao ha tela nova nem painel novo.
--  * `usuario_e_gestao` / `usuario_e_gestao_fila`: a gestao continua vendo tudo.
--
-- Reversivel: supabase/rollbacks/20261020173531_*.rollback.sql

-- ===========================================================================
-- 1. O SELO: mesma janela de D-2, destinatario certo
-- ===========================================================================
create or replace function public.parcelas_vencendo_2_dias()
returns table(aluno_nome text, aluno_id uuid, numero integer, valor numeric, vencimento date, operador_email text, operador_nome text)
language sql
security definer
set search_path to 'public'
as $function$
  select a.nome, ac.aluno_id, p.numero, p.valor, p.vencimento, c.operador_email, c.operador_nome
  from public.parcelas p
  join public.acordos ac on ac.id = p.acordo_id
  join public.alunos a on a.id = ac.aluno_id
  -- O dono OPERACIONAL do aluno. `limit 1` porque um aluno pode ter mais de um
  -- caso e a fila nao pode repetir a mesma parcela (artigo 4).
  left join lateral (
    select k.operador_email, k.operador_nome, k.nao_acionar, k.cpf_limpo,
           k.status_atual, k.status_acionamento, k.status_financeiro, k.status_jornada
      from public.casos k
     where k.aluno_id = ac.aluno_id and k.operador_email is not null
     order by k.caso_atualizado_em desc nulls last
     limit 1
  ) c on true
  where public.parcela_viva(p.status)
    and p.vencimento = current_date + interval '2 days'
    -- Artigo 6: nao disponibilizar para acionamento quem esta bloqueado.
    and not coalesce(c.nao_acionar, false)
    and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual,
              c.status_acionamento, c.status_financeiro, c.status_jornada)
    and (
      public.usuario_e_gestao_fila()
      or lower(c.operador_email) = lower(coalesce(auth.jwt()->>'email',''))
    )
  order by p.vencimento asc;
$function$;

comment on function public.parcelas_vencendo_2_dias() is
  'Parcelas de acordo vencendo em exatamente 2 dias, enderecadas ao dono do CASO '
  '(nao ao dono financeiro do acordo). Janela de D-2 preservada de proposito: a tela '
  'usa isto como SELO na fila, e abrir para vencidas acenderia a carteira inteira. '
  'As vencidas estao em acordo_alertas_do_operador. Nao escreve nada.';

-- ===========================================================================
-- 2. A LISTA: alerta D-2 + vencidas de ate 30 dias, destinatario certo
-- ===========================================================================
create or replace function public.acordo_alertas_do_operador(p_aluno_id uuid default null::uuid)
returns table(aluno_id uuid, aluno_nome text, acordo_id uuid, numero_acordo integer, parcela_id uuid, numero_parcela integer, valor numeric, vencimento date, dias_restantes integer, data_alerta date, responsavel_email text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  -- PERNA 1: o alerta D-2 que ja existe, agora pelo dono do CASO. So a vencer --
  -- a fronteira que impede duplicidade com a perna 2.
  select x.aluno_id, al.nome::text, x.acordo_id, a.numero_acordo::int, x.parcela_id,
         x.numero_parcela::int, x.valor::numeric, x.vencimento,
         (x.vencimento - current_date)::int, x.data_alerta, c.operador_email
    from public.acordo_alertas_parcela x
    join public.acordos a on a.id = x.acordo_id
    left join public.alunos al on al.id = x.aluno_id
    left join lateral (
      select k.operador_email, k.nao_acionar, k.cpf_limpo, k.status_atual,
             k.status_acionamento, k.status_financeiro, k.status_jornada
        from public.casos k
       where k.aluno_id = x.aluno_id and k.operador_email is not null
       order by k.caso_atualizado_em desc nulls last limit 1
    ) c on true
   where x.resolvido_em is null and x.tipo = 'D2'
     and x.vencimento >= current_date
     and (p_aluno_id is null or x.aluno_id = p_aluno_id)
     and not coalesce(c.nao_acionar, false)
     and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual,
               c.status_acionamento, c.status_financeiro, c.status_jornada)
     and (public.usuario_e_gestao()
          or lower(coalesce(c.operador_email,'')) = lower(coalesce(auth.jwt()->>'email','')))

  union all

  -- PERNA 2: as VENCIDAS de ate 30 dias, que hoje nao aparecem em fila nenhuma.
  -- `dias_restantes` sai negativo, e e assim que a tela distingue uma da outra.
  select a.aluno_id, al.nome::text, a.id, a.numero_acordo::int, p.id,
         p.numero::int, p.valor::numeric, p.vencimento,
         (p.vencimento - current_date)::int, p.vencimento, c.operador_email
    from public.parcelas p
    join public.acordos a on a.id = p.acordo_id
    left join public.alunos al on al.id = a.aluno_id
    left join lateral (
      select k.operador_email, k.nao_acionar, k.cpf_limpo, k.status_atual,
             k.status_acionamento, k.status_financeiro, k.status_jornada
        from public.casos k
       where k.aluno_id = a.aluno_id and k.operador_email is not null
       order by k.caso_atualizado_em desc nulls last limit 1
    ) c on true
   where public.parcela_viva(p.status)
     and coalesce(a.status,'') <> 'CANCELADO'
     and p.vencimento < current_date
     and p.vencimento >= current_date - interval '30 days'
     and a.aluno_id is not null
     and (p_aluno_id is null or a.aluno_id = p_aluno_id)
     and not coalesce(c.nao_acionar, false)
     and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual,
               c.status_acionamento, c.status_financeiro, c.status_jornada)
     and (public.usuario_e_gestao()
          or lower(coalesce(c.operador_email,'')) = lower(coalesce(auth.jwt()->>'email','')))

  order by 8, 2;
$function$;

comment on function public.acordo_alertas_do_operador(uuid) is
  'Parcelas de acordo sob acompanhamento do dono do CASO: o alerta D-2 (a vencer) '
  'mais as VENCIDAS de ate 30 dias, que nao estavam em fila nenhuma. '
  '`dias_restantes` negativo = vencida. As duas pernas sao disjuntas por data, '
  'entao a mesma parcela nunca aparece duas vezes. Honorario, autoria e '
  'titularidade financeira do acordo nao sao lidos nem escritos.';
