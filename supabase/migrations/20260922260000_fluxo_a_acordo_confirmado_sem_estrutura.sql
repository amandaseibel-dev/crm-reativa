-- FLUXO A: PAGAMENTO SEM ESTRUTURA DE ACORDO, COM NEGOCIACAO CONFIRMADA (166).
--
-- Escopo deliberadamente SEPARADO do FLUXO B (titulo original liquidado na Prime,
-- conciliacao_liquidar_titulo_por_prime). Esta migration NAO liga fluxo_pagamentos_config.consulta_portador
-- (que aciona os dois fluxos juntos, via a Edge Function prime-portador) -- em vez disso, chama diretamente
-- as MESMAS RPCs oficiais que ja existem para a parte 166, pulando inteiramente a parte de titulo
-- liquidado. conciliacao_liquidar_titulo_por_prime nao e chamado em nenhum ponto deste arquivo.
--
-- SIMPLIFICACAO DELIBERADA, REGISTRADA: nao faz uma nova chamada ao vivo a GET /agreements para cada caso.
-- Usa o fato ja medido e documentado no proprio codigo da Edge Function prime-portador -- /agreements
-- respondeu vazio em 100% dos casos testados (59 alunos do 166 + 13 divergentes) -- para registrar
-- NAO_ENCONTRADA via a RPC oficial existente (conciliacao_registrar_consulta_estrutura), sem inventar
-- payload nenhum. Se um dia a Prime passar a devolver estrutura, isso e um fato novo para tratar a parte --
-- nao teria como esta rotina criar acordo/parcela a partir dela de qualquer forma (o mapeamento nao existe).
--
-- CRITERIO ESTRUTURAL (nao por lista de ids -- cobre os 34 atuais e qualquer caso futuro igual):
--   status_conciliacao = 'AGUARDANDO_ACORDO'   (sem baixa, sem vinculo financeiro conclusivo)
--   aluno_id preenchido, cpf preenchido, exatamente 1 aluno com esse cpf
--   titulo_numero preenchido
--   nao existe acordo (nao cancelado) com numero_ulbra = titulo_numero
--   nao existe parcela com boleto = numero_parcela_completo
--   cpf confirmado no espelho do portador 166 (prime_portador_membro, ja atualizado pela varredura semanal
--     que continua ativa e independente desta pausa)
--
-- POSSIVEL_REACORDO: so diagnostico, texto em fila_pagamento_sem_vinculo.observacao. Nunca vincula a esse
-- outro acordo, nunca cria parcela, nunca decide baixa por ele.
begin;

create or replace function public.pagamentos_confirmar_sem_estrutura(p_limite int default 200)
 returns jsonb language plpgsql security definer set search_path to 'public' set statement_timeout to '60s'
as $function$
declare
  c record; v_res jsonb; v_reacordo record;
  v_ator constant text := 'confirmacao-166@sistema';
  v_confirmados int := 0; v_reacordo_marcados int := 0; v_pulados int := 0; v_falhas int := 0;
begin
  for c in
    select p.id, p.cpf, p.titulo_numero, p.numero_parcela_completo, p.aluno_id
      from public.pagamentos p
     where p.status_conciliacao = 'AGUARDANDO_ACORDO'
       and p.aluno_id is not null
       and coalesce(p.cpf, '') <> ''
       and coalesce(p.titulo_numero, '') <> ''
       and (select count(*) from public.alunos a2
              where lpad(regexp_replace(coalesce(a2.cpf, ''), '\D', '', 'g'), 11, '0')
                  = lpad(regexp_replace(p.cpf, '\D', '', 'g'), 11, '0')) = 1
       and not exists (select 1 from public.acordos a where a.numero_ulbra = p.titulo_numero and upper(coalesce(a.status, '')) <> 'CANCELADO')
       and not exists (select 1 from public.parcelas pr where pr.boleto = ltrim(coalesce(p.numero_parcela_completo, ''), '0'))
       and exists (select 1 from public.prime_portador_membro m
                     where m.portador = 166
                       and lpad(m.cpf, 11, '0') = lpad(regexp_replace(p.cpf, '\D', '', 'g'), 11, '0'))
     order by p.id
     limit greatest(coalesce(p_limite, 200), 1)
  loop
    begin
      -- reavaliacao fresca: continua elegivel agora?
      if not exists (select 1 from public.pagamentos p2 where p2.id = c.id and p2.status_conciliacao = 'AGUARDANDO_ACORDO') then
        v_pulados := v_pulados + 1;
        continue;
      end if;

      perform public.conciliacao_registrar_consulta_estrutura(c.id, 'NAO_ENCONTRADA');

      perform set_config('request.jwt.claims', jsonb_build_object('email', v_ator, 'role', 'service_role')::text, true);
      v_res := public.conciliacao_confirmar_portador_166(c.id, c.cpf, 'PRIME_PORTADOR_MEMBRO');
      perform set_config('request.jwt.claims', '', true);

      if coalesce((v_res->>'ok')::boolean, false) then
        v_confirmados := v_confirmados + 1;
      else
        v_pulados := v_pulados + 1;
      end if;

      -- diagnostico: outro acordo do mesmo aluno, numero diferente -- NUNCA vincula
      select a.id, a.numero_ulbra into v_reacordo
        from public.acordos a
       where a.aluno_id = c.aluno_id and a.numero_ulbra is distinct from c.titulo_numero
         and upper(coalesce(a.status, '')) in ('ATIVO', 'QUITADO')
       limit 1;
      if found then
        update public.fila_pagamento_sem_vinculo
           set observacao = coalesce(observacao, '')
             || case when coalesce(observacao, '') = '' then '' else ' | ' end
             || 'POSSIVEL_REACORDO: aluno possui acordo ' || coalesce(v_reacordo.numero_ulbra, '?')
             || ' (id ' || v_reacordo.id || '), diferente do titulo_numero ' || c.titulo_numero
             || ' referenciado no pagamento. Diagnostico apenas -- nao vinculado.'
         where pagamento_id = c.id and decisao is null
           and coalesce(observacao, '') not like '%POSSIVEL_REACORDO%';
        if found then v_reacordo_marcados := v_reacordo_marcados + 1; end if;
      end if;
    exception when others then
      v_falhas := v_falhas + 1;
    end;
  end loop;

  return jsonb_build_object('ok', true, 'confirmados_sem_estrutura', v_confirmados,
                             'reacordo_marcados', v_reacordo_marcados, 'pulados', v_pulados, 'falhas', v_falhas);
end;
$function$;

revoke all on function public.pagamentos_confirmar_sem_estrutura(int) from public, anon, authenticated;
grant execute on function public.pagamentos_confirmar_sem_estrutura(int) to service_role;

commit;
