(function (raiz) {
  'use strict';
  // Regras puras dos cards da TV (sem DOM, testáveis em node).
  // Nada aqui calcula dinheiro novo: formata o que o CRM entregou e compara
  // com a meta oficial (metas_projecao), nunca com a projeção.

  const brl2 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const brl0 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const pct1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const inteiro = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

  const ehNumero = (n) => typeof n === 'number' && Number.isFinite(n);

  // Com centavos só quando a fonte tem centavos ('centavos'). O snapshot antigo
  // grava inteiros: mostrar ",00" ali seria inventar casa decimal.
  // Intl usa espaço não separável depois de "R$"; a TV mostra espaço comum.
  function dinheiro(valor, precisao) {
    if (!ehNumero(valor) || valor < 0) return '—';
    const txt = (precisao === 'centavos' ? brl2 : brl0).format(valor);
    return txt.replace(/ /g, ' ');
  }

  function quantidade(n) {
    return ehNumero(n) && n >= 0 ? inteiro.format(n) : '—';
  }

  // % da meta de honorários atingido. Sem meta → null (não inventa).
  function percentualMeta(realizado, meta) {
    if (!ehNumero(realizado) || !ehNumero(meta) || meta <= 0) return null;
    return (100 * realizado) / meta;
  }

  function percentual(p) {
    return ehNumero(p) ? pct1.format(p) + '%' : '—';
  }

  // Ritmo: quanto da meta deveria estar feito até hoje, pelos dias úteis do
  // calendário do CRM (dias_uteis(), feriados inclusos). Mesma regra vigente
  // da projeção: os dias úteis até hoje INCLUEM hoje.
  function ritmo(realizado, meta, diasAteHoje, diasMes) {
    if (!ehNumero(realizado) || !ehNumero(meta) || meta <= 0) return null;
    if (!ehNumero(diasAteHoje) || !ehNumero(diasMes) || diasMes <= 0 || diasAteHoje < 0) return null;
    const esperado = (meta * Math.min(diasAteHoje, diasMes)) / diasMes;
    const diferenca = realizado - esperado;
    return {
      esperado,
      diferenca,
      situacao: Math.abs(diferenca) < 0.005 ? 'no_ritmo' : diferenca > 0 ? 'acima' : 'abaixo',
      diasAteHoje,
      diasMes,
    };
  }

  function iniciais(nome) {
    const partes = String(nome || '').trim().split(/\s+/).filter(Boolean);
    if (!partes.length) return '?';
    const a = partes[0][0] || '';
    const b = partes.length > 1 ? partes[partes.length - 1][0] : '';
    return (a + b).toLocaleUpperCase('pt-BR');
  }

  // Nome curto para a TV: primeiro nome + inicial do último, em caixa de título.
  function nomeCurto(nome) {
    const partes = String(nome || '').trim().split(/\s+/).filter(Boolean);
    if (!partes.length) return '';
    const cap = (s) => s.charAt(0).toLocaleUpperCase('pt-BR') + s.slice(1).toLocaleLowerCase('pt-BR');
    return partes.length > 1 ? `${cap(partes[0])} ${cap(partes[partes.length - 1]).charAt(0)}.` : cap(partes[0]);
  }

  // Só aceita URL https de foto (a assinada do Storage). Qualquer outra coisa → iniciais.
  function fotoSegura(url) {
    return typeof url === 'string' && /^https:\/\//i.test(url) ? url : null;
  }

  // Ranking: null = dado indisponível (a fonte não mandou); [] = ninguém pontuou
  // no período. Os dois são mostrados de forma diferente e nenhum é preenchido.
  // Cada item sai SÓ com posição, nome e foto: qualquer valor, quantidade ou
  // data que viesse junto é descartado aqui (a TV não mostra resultado individual).
  function ranking(lista) {
    if (!Array.isArray(lista)) return null;
    return lista
      .filter((r) => r && typeof r === 'object' && String(r.nome || '').trim())
      .slice(0, 3)
      .map((r, i) => ({ posicao: i + 1, nome: String(r.nome).trim(), foto: fotoSegura(r.foto) }));
  }

  // Critério de cada ranking fica no subtítulo do card — a ordem é do CRM, o
  // resultado individual não aparece.
  const RANKINGS = [
    { chave: 'top_honorario_pagamento_mes', titulo: 'Top honorários do mês', periodo: 'mes',
      criterio: 'Maiores honorários pagos em um único pagamento' },
    { chave: 'top_recuperado_mes', titulo: 'Top recuperado do mês', periodo: 'mes',
      criterio: 'Maior valor recuperado acumulado no mês' },
    { chave: 'top_pagamentos_hoje', titulo: 'Top pagamentos de hoje', periodo: 'hoje',
      criterio: 'Mais pagamentos confirmados hoje' },
    { chave: 'top_acordos_hoje', titulo: 'Top acordos de hoje', periodo: 'hoje',
      criterio: 'Mais acordos fechados hoje, sem cancelados nem duplicados' },
  ];

  raiz.tvDestaques = {
    dinheiro, quantidade, percentualMeta, percentual, ritmo, iniciais, nomeCurto,
    fotoSegura, ranking, RANKINGS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
