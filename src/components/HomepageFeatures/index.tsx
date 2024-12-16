import clsx from 'clsx';
import Heading from '@theme/Heading';
import styles from './styles.module.css';
import Link from '@docusaurus/Link';

type FeatureItem = {
  title: string;
  Svg: React.ComponentType<React.ComponentProps<'svg'>>;
  description: JSX.Element;
  linkTo: string;
};

const FeatureList: FeatureItem[] = [
  {
    title: 'Workload Identities in AKS',
    Svg: require('@site/static/img/azure-aks-color.svg').default,
    description: (
      <>
      Learn how to setup your cluster for using Azure Workload Identity
      </>
    ),
    linkTo: '/docs/aks/aks-workload-identity'
  },
  {
    title: 'Scaling pods and nodes in AKS',
    Svg: require('@site/static/img/azure-aks-color.svg').default,
    description: (
      <>
      Learn how to scale your AKS resources using KEDA and Cluster Autoscaler
      </>
    ),
    linkTo: '/docs/aks/aks-scaling'
  }
];

function Feature({title, Svg, description, linkTo}: FeatureItem) {
  return (
    <div className={clsx('col col--4')}>
      <div className="text--center">
        <Svg className={styles.featureSvg} role="img" />
      </div>
      <div className="text--center padding-horiz--md">
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
        <Link
            className="button button--secondary button--lg"
            to={linkTo}>
            Read
          </Link>
      </div>
    </div>
  );
}

export default function HomepageFeatures(): JSX.Element {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row justify-content-center">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
