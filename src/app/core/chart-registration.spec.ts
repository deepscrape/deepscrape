import { Chart } from 'chart.js';
import './chart-registration';

/**
 * These four names are exactly what the admin analytics page threw at runtime. The guard is
 * cheap and it fails here, in the suite, instead of on a dashboard an admin is looking at.
 */
describe('chart registration', () => {
  it('registers the scales and controllers BaseChartDirective renders', () => {
    expect(() => Chart.registry.getScale('linear')).not.toThrow();
    expect(() => Chart.registry.getScale('category')).not.toThrow();
    expect(() => Chart.registry.getScale('radialLinear')).not.toThrow();
    expect(() => Chart.registry.getController('pie')).not.toThrow();
  });
});
