-- ATÉ QUANDO A CARTEIRA ENXERGA.
--
-- POR QUE ISTO EXISTE. Em 08/09/2026 o ultimo bordero recebido foi o 701, de
-- 11/08, cobrindo vencimentos ate 10/07. Nao ha NENHUM titulo em aberto vencendo
-- depois disso -- julho, agosto e setembro nao entraram, porque a Ulbra ainda
-- nao mandou os borderos seguintes.
--
-- Nao e defeito do CRM. Mas enquanto ninguem escreve isso na tela, todo numero
-- da carteira e lido como se fosse de hoje. Os R$ 42,5 milhoes nao sao a
-- inadimplencia de hoje: sao a inadimplencia ATE 10/07. A diferenca importa
-- quando alguem decide meta, comissao ou prioridade em cima do numero.
--
-- Tambem serve de cobranca: com a data na tela, o atraso do bordero deixa de
-- ser invisivel e vira conversa com a Ulbra.
--
-- Custo: ~5ms. Le duas linhas indexadas, nao varre carteira.
create or replace function public.base_data_de_corte()
 returns jsonb
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select jsonb_build_object(
    -- Ate que vencimento a base enxerga: o titulo em aberto mais novo.
    'cobre_ate', (select max(vencimento) from public.acordos_titulos
                   where situacao = 'ABERTO' and vencimento is not null),
    'dias_desde_o_corte', (select current_date - max(vencimento)
                             from public.acordos_titulos
                            where situacao = 'ABERTO' and vencimento is not null),
    'ultimo_bordero_em', (select max(created_at)::date from public.importacoes
                           where tipo = 'BORDERO'),
    'ultimo_bordero_ref', (select i.referencia from public.importacoes i
                            where i.tipo = 'BORDERO' order by i.created_at desc limit 1),
    'dias_sem_bordero', (select current_date - max(created_at)::date
                           from public.importacoes where tipo = 'BORDERO'),
    'consultado_em', now()
  );
$function$;

-- Todo mundo que opera precisa saber ate quando o numero vale -- nao e dado de
-- gestao. Anonimo nao entra, como em tudo aqui.
revoke all on function public.base_data_de_corte() from public, anon;
grant execute on function public.base_data_de_corte() to authenticated;

comment on function public.base_data_de_corte() is
  'Ate que vencimento a carteira enxerga e quando entrou o ultimo bordero. Usado pelo selo de data de corte nas telas de numero.';
